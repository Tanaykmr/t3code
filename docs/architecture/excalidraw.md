# Excalidraw boards in T3 Code

## Data shapes

| Record             | Fields and invariants                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Board              | `boardId`, `threadId`, `sceneFormatVersion`, `revision`, `orderRevision`, and timestamps. One board per thread in the first release. The client address is `(environmentId, threadId, boardId)`. The owning environment comes from the connection.                                                                                                                                                              |
| Scene              | Ordered native Excalidraw elements, including deleted elements, plus shared document settings such as canvas background and a manifest of image files. Preserve native IDs, geometry, fractional `index`, groups, frames, text and arrow bindings, `seed`, `version`, `versionNonce`, `updated`, and `isDeleted`. Viewport, selection, tools, theme, undo history, and personal libraries belong to the client. |
| File               | An Excalidraw `fileId` mapped to an immutable environment-owned blob, with MIME type, byte size, digest, and the metadata needed to reconstruct an Excalidraw binary file entry. Scene messages carry references. Clients fetch missing bytes separately.                                                                                                                                                       |
| Edit batch         | `boardId`, stable `mutationId`, optional order precondition, and a bounded set of element operations and setting or file changes. Resolve actor and permissions from the authenticated caller. Batches commit atomically.                                                                                                                                                                                       |
| Element operation  | Create with an unused ID, replace or delete with the element's expected authoritative `(version, versionNonce)`, or explicitly restore with the current tombstone's pair. A membership, binding, or layer operation can change several elements in the same batch. Omission has no meaning.                                                                                                                     |
| Snapshot and delta | A snapshot contains the board header and scene at revision R. A delta identifies the board, revision R+1, accepted mutation ID, canonical changed records, and any order, setting, or file changes. A rejection identifies conflicting IDs and their current tokens.                                                                                                                                            |

The board revision is the order of committed batches. The order revision changes when the
ordered ID list changes and fences operations that rearrange existing elements. The native
version pair identifies a specific accepted state of one element. The server stamps canonical
versions and nonces on accepted changes. For native editor writes it stamps a version above
both the prior canonical version and the bounded editor proposal version, so cache and history
consumers can distinguish the accepted record from its proposal. Editor proposals must be
validated and can never modify the expected token. Timestamps are for display and diagnostics.
Format version governs decoding and migrations independently of editing. Keep tombstones and
mutation receipts for the lifetime of the board in the first release.

## Ownership and persistence

The environment server owns the latest scene in its existing `statev2.sqlite`. Use a dedicated
board service and tables for board metadata, element payloads keyed by ID, file references, and
mutation receipts. Update changed element rows, the revision, and the receipt in one
transaction. Image bytes ride inline in the edit batch and are stored in a `board_file` table in
the same transaction, so a file always belongs to the board it was committed with and there is
no staging to expire. Files are immutable and kept for the board's lifetime, so restoring an
element also restores its image. (Note: this replaces the earlier asset-storage plan; the asset
store would have needed staging and a second commit.) Opening a board after a restart reads
committed rows directly.

Create a board explicitly from the sidebar or the thread's agent, idempotently for its owning
thread. Displaying a missing board has no write side effect. Closing a panel, ending a turn,
archiving a thread, or switching branches preserves the board. Forking a thread starts with its
own empty board on first creation. Permanent thread deletion removes the board through
the thread deletion lifecycle and retires its asset references. Use the editor's native
`.excalidraw` export and import for portable copies. Git checkpoints govern the checkout, and
the board has an independent lifetime across checkpoint restores.

This is environment state, so an agent can edit with every panel closed and a remote renderer
can reconnect to the same board. A dedicated stream keeps freehand activity out of the thread
and sidebar feeds. The T3 thread subscription is the local reference for the snapshot/live
handoff. The orchestration event sink demonstrates post-commit publication and durable
receipts, without making drawing edits orchestration events.
[Thread subscription](../../apps/server/src/ws.ts#L921) ·
[Event sink](../../apps/server/src/orchestration-v2/EventSink.ts) ·
[Database configuration](../../apps/server/src/config.ts#L153)

## Editing and live sync

**Server commit.** Serialize commits per board. Look up the receipt first. A retry with the
same caller, mutation ID, and payload returns the original result. Reusing the ID with a
different payload fails. Check expected element pairs against committed rows. Two edits to
different independent elements can commit even if both started at the same board revision.
Two edits to one element, including a delete versus an update, resolve to the first accepted
batch. The second batch gets a conflict, and the caller decides how to preserve its intent.
Related element changes are atomic. A failed batch neither increments the revision nor
publishes an event.

The service validates the resulting scene where a write affects references or ordering.
Element IDs remain reserved after deletion. A box, its bound label, and affected connectors
travel together when their bindings change. Include their expected versions where they are
updated. Keep Excalidraw's fractional indices in storage and on the wire. Append new
agent elements under the same write lock. For an explicit editor reorder, use the displayed
order revision and the affected elements' order relative to stable neighbors. Generate or
normalize colliding indices once on the server before publishing, with an explicit canonical
array order and any repaired records in the same delta. Keep bound text in the correct
position relative to its container. Verify the ordering and normalization against the exact
editor release before enabling writes.

**Subscription.** Open a board-scoped authenticated Effect RPC stream. Register the subscriber
and read its initial snapshot under the board's commit/publication fence, then send the
snapshot followed by ordered committed deltas. For the first release, reconnect with a fresh
snapshot. Clients ignore already-seen revisions, reopen on a gap or a bounded queue overflow,
and retry any unacknowledged immutable batch with its original mutation ID. Keep commit and
in-process publication ordered. A process restart closes streams, and the next snapshot
recovers committed state even if a publish was interrupted. A write response is a receipt.
Stream order determines how the client advances its authoritative mirror. Retry belongs
to the board operation, following the connection runtime's treatment of mutations.
[Connection runtime](../internals/09_connection-runtime.md#subscriptions-caching-and-mutations)

**Editor integration.** Mount once from `initialData`. Maintain an authoritative mirror and an
optimistic local overlay in the editor adapter. In `onChange`, inspect native document changes
using `getSceneElementsIncludingDeleted()` and the file map. Snapshot observed records by value
because the editor can mutate them. Track IDs and content against the last rendered baseline,
including programmatic updates, so view-only changes and remote echoes generate no writes.
Capture completed native edits and coalesce nearby changes into bounded batches. The
0.18.1 public types expose `onChange`. Qualify the gesture/idle boundary with drag, freehand,
typing, IME, undo, import, and keyboard actions before introducing sync. Read-after-write for agents means after the editor reports the edit
saved. In-flight strokes and unsubmitted text stay on the editing client.

Apply commits as the complete ordered scene assembled from the mirror plus valid local
overlays, since `updateScene` replaces the element array. Use
`CaptureUpdateAction.NEVER` for remote apply and acknowledgements. Load missing images with
`addFiles` and deduplicate file loads. Register the expected inbound records before calling
the API and check the subsequent observation. A content-identical version or index repair
caused by inbound apply is an acknowledgement or a compatibility fault, never a user write.
Try one fresh snapshot if inbound apply changes content. If the discrepancy persists,
show a read-only compatibility error and keep any unsaved draft available for export. Browser undo/redo
generates a normal local edit with current expected versions. Remote changes stay out of
local undo history. The editor applies undo as a property-level delta. Test that a remote
change to a different property survives undo. Undoing a property that was also changed
remotely follows the stock editor's behavior and submits a new edit against the current
visible record. The normal conflict rule applies if another write races that undo.
[Excalidraw history](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/packages/excalidraw/history.ts#L19-L52)

With a gesture or text edit active, hold incoming updates for that gesture's affected IDs
out of the visible editor until the interaction finishes. Continue advancing the authoritative
mirror and displaying unrelated remote changes. Frozen draft IDs and their expected tokens
come from the interaction's starting view. Destructive or structural changes that touch
the same bindings or index neighborhood may need to defer the whole visual apply until
the gesture finishes. Send one batch in flight per board from each editor. Use the accepted
tokens for later edits that extend the client's own acknowledged edit, and preserve the old
token on a pending edit if a different actor changed the same element. On conflict, show the
committed scene and retain the rejected local draft for inspection, export, or explicit save
as a copy with fresh IDs. Keep retryable drafts visible as unsaved through reconnect or
panel close. A disconnect puts the board in read-only mode for new gestures until it has
resynchronized. There is no automatic replay of a rejected stale edit.

Excalidraw's peer reconciler takes the higher version, then the lower nonce for equal
versions, with exceptions for active elements that vary by release. It merges by ID, orders
by fractional index, and can repair those indices. The hosted app also restores incoming
records, suppresses rebroadcast, and manages image files separately. Those are useful
adapter patterns. For T3, a stale edit means its author was missing a committed change.
Returning that conflict preserves a chance to recover intent that a nonce tie-break would
discard. Also, `updateScene` can repair indices by mutating a record and bumping its native
version, which is why normalized canonical order and echo suppression are release gates.
[Peer reconciliation](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/packages/excalidraw/data/reconcile.ts#L23) ·
[Hosted collaboration adapter](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/excalidraw-app/collab/Collab.tsx#L772) ·
[0.18.1 scene replacement](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/components/App.tsx#L3885) ·
[0.18.1 fractional index repair](https://github.com/excalidraw/excalidraw/blob/a2ec2889babf7d2295469c6d90ebe77fae57df84/packages/excalidraw/fractionalIndex.ts#L188) ·
[Imperative API](https://plus.excalidraw.com/docs/sdk/excalidraw/api/props/excalidraw-api)

## Agent tool surface

| Proposed tool  | Contract                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board_get`    | Read the calling thread's board and revision. Return a compact scene summary, with optional IDs, text search, or bounds and paginated details, including expected version pairs. A multipage read signals a changed revision so the agent can restart if it needs a consistent view. Board text is untrusted document content.                    |
| `board_create` | Get or create the caller's board. Return identity and revision. The tool works even if the editor is closed.                                                                                                                                                                                                                                      |
| `board_apply`  | Apply a single create, patch, delete, or restore batch of typed element edits. Return actual committed IDs, their tokens and the board revision, or structured conflicts. Resolve new labels and arrow endpoints in the batch and enforce preconditions for existing dependencies. The agent rereads after a conflict before making another edit. |

Use a small model-facing vocabulary for rectangles, diamonds, ellipses, text, arrows, and
lines at launch, with optional labels and endpoint IDs. The server materializes native
records and updates safe fields on existing records without dropping the rest. Geometry,
text wrapping, and two-way bindings need real fixtures from the pinned editor. Use a small
headless materializer with explicit layout inputs and deterministic defaults. Excalidraw's
browser conversion measures text and is a compatibility reference. If the first slice
supports only standalone labels or explicit coordinates, grow binding support before the
agent tool is enabled by default. An agent can read native shapes beyond the initial
editing vocabulary. The editor uses its full set of native element types.

Mermaid is an optional one-way import for starting a diagram. Keep the package's native
import UI, and route its output through the same batch boundary with fresh IDs. A future
agent `board_import_mermaid` should use a pinned, sandboxed converter that works with no
open panel, and should append converted elements with ordinary conflict checks. Native
elements remain editable after import. Re-rendering a Mermaid string on each edit would
discard element identity and freehand work. The current editor's Mermaid UI calls the
editor API for conversion, while the model-facing conversion API has text measurement
and binding dependencies worth testing before using it on the server.
[Element conversion](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/packages/element/src/transform.ts#L680) ·
[Mermaid UI](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/packages/excalidraw/components/TTDDialog/MermaidToExcalidraw.tsx#L206)

Register a board toolkit in T3's MCP server. Resolve the board from the authenticated thread
invocation so neither the prompt nor an arbitrary board ID can redirect a write. Expose reads
and writes according to the invoking session's grants and mode. Keep mutations out of
read-only and plan-only invocations. External MCP clients and agent-initiated access to
another thread need an explicit grant before exposure. Use the same service from a scheduled
task only when it already has a trusted owning-thread context. Tool responses should report
committed outcomes and stay small enough for the provider transcript.

Codex and Claude are the first real-provider acceptance targets. Cursor, Grok, OpenCode,
Antigravity, Kiro, Pi, Muse Code, and fx use the same toolkit wherever their existing T3 MCP
session path supports it. Verify advertisement and invocation on each supported path before
claiming support. A driver or mode without T3 MCP injection, such as an externally managed
OpenCode connection, has no board tools in that session. The editor and authenticated UI
writes work independently of provider choice. Use the existing discovery path and model
evals for tool selection, incrementally editing a user drawing, and conflict recovery.
[MCP composition](../../apps/server/src/mcp/McpHttpServer.ts) ·
[Invocation context](../../apps/server/src/mcp/McpInvocationContext.ts) ·
[Tool access](../../apps/server/src/mcp/McpToolAccess.ts) ·
[Provider session contract](../../packages/provider-core/src/server/McpProviderSessions.ts) ·
[OpenCode adapter](../../packages/provider-opencode/src/server/adapter.ts#L1095) ·
[Model-facing evals](../../evals/README.md)

## Sidebar, panel, and module boundaries

| Boundary                                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web` shell                                   | Add an Excalidraw action to the sidebar for the active persisted thread and the command palette. Both open the same named board tab through the existing thread-scoped right-panel state. A draft thread can start a real thread first. Reuse resize, maximize, sheet fallback for narrow widths, close, and keyboard focus return. Keep chat and compose available alongside the editor at desktop widths.                                |
| `apps/web` Excalidraw adapter                      | Lazy-load the actual package, stylesheet, toolbar and dialogs. Own the imperative editor bridge, identity and history across updates, file hydration, native import/export, and user-visible conflict recovery. Preserve native editing shortcuts while the canvas has focus. Translate T3 chrome with the existing system and map T3 locale to a supported package locale.                                                                |
| `packages/contracts` and `packages/client-runtime` | Version the board records, method availability, and RPC errors. Use environment-keyed query and subscription atoms and `createEnvironmentRpcCommand` for mutations. Gate controls with `permissionAtom` and add guarded RPC methods to `CLIENT_GUARDED_RPC_SCOPES`. Reduce every delta in order before exposing the latest view. Share the connection and scene protocol across clients without importing React DOM or the editor package. |
| `apps/server` board service                        | Own validation, persistence, commit ordering, and file authorization. Use thin WebSocket, asset HTTP, and MCP handlers. Authorize against the actual owning thread and board on every operation and stream subscription. Use the thread's existing orchestration read and operate grants for this thread-owned feature. Cancel streams on session revocation using the environment lifecycle.                                              |
| Desktop, hosted web, and mobile                    | Electron uses the same web renderer and environment connection. Self-hosted and hosted web use their normal selected-environment connection, including remote, relay, and tunnel sessions. Native mobile keeps chat and provider access and can open the thread board in the paired web experience once supported. A native editor would require a separately qualified WebView with auth and file bridging.                               |

The recommended desktop entry is a line-icon action on the owning thread row, following
the sidebar's linked PR action. The alternative is a labeled action for the active
thread, which improves discoverability at the cost of sidebar space. Both open the same
right-hand panel. The Figma frames reserve the editor's space and illustrate the T3
chrome and placement. [Thread-row action](../../apps/web/src/components/sidebar/SidebarThreadRow.tsx#L1121) ·
[Desktop v1 · thread row](https://www.figma.com/design/WINbt6aQCvKH5q4SherSoC/Design-System-v2--Tanay-s-2nd-Copy-?node-id=5511-2) ·
[Desktop v2 · labeled sidebar action](https://www.figma.com/design/WINbt6aQCvKH5q4SherSoC/Design-System-v2--Tanay-s-2nd-Copy-?node-id=5511-69)

The panel is a peer of Files, Browser, and Terminal. Persist its open state and board
reference in the existing panel store, and subscribe only while the board surface is active.
Keep unsaved drafts and pending receipts outside the mounted editor, keyed by environment
and board, so tab changes cannot send edits to a different thread. Use the existing
reopen and maximize actions. No separate settings page or default global shortcut is
needed. A deployment with an older server should report that boards require an update
before it opens an editor. Read-only sessions can view a board they are entitled to read.
The anonymous guest surface and cross-environment peer inspection require their own access
design before exposing board content.

The experience ships the full editor capabilities of the pinned open-source package,
including drawing tools, editing, layer order, library, clipboard, undo/redo, and supported
imports and exports. Persist the personal library through `onLibraryChange`, and follow
T3's content policy for external embeds via `validateEmbeddable`. Excalidraw.com and
Excalidraw+ also provide hosted application services, including public share links and AI.
T3 owns collaborative storage. Clarify whether public links and external collaborators
belong in a later product release.
[Sidebar chrome](../../apps/web/src/components/sidebar/SidebarChrome.tsx) ·
[Thread panel state](../../apps/web/src/rightPanelStore.ts) ·
[Panel layout](../../apps/web/src/components/chat/ChatRightPanel.tsx) ·
[Panel composition](../../apps/web/src/components/RightPanelTabs.tsx) ·
[Subscription atom precedent](../../packages/client-runtime/src/state/preview.ts) ·
[RPC authorization](../../apps/server/src/auth/RpcAuthorization.ts) ·
[Excalidraw package integration](https://plus.excalidraw.com/docs/sdk/excalidraw/integration) ·
[Excalidraw+ MCP](https://plus.excalidraw.com/docs/mcp)

## Precedents and tradeoffs

### Official open-source Excalidraw MCP

`read_me` teaches a compact drawing format. `create_view` streams a diagram into an MCP App, and the widget's `onChange` saves a checkpoint and adds edit context. Use the compact vocabulary and feedback pattern. T3 needs a board ID, authorized reads, atomic edits, and revisioned push independent of a rendered tool result. [Tools](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/server.ts#L401) · [Widget edit context](https://github.com/excalidraw/excalidraw-mcp/blob/157aa23ceb1976008aadc89eb05e3444060f09d6/src/edit-context.ts#L92)

### yctimlin MCP canvas and Excaliclaude

yctimlin's service broadcasts agent changes and the editor autosyncs through `onChange`. Its headless export code shows how compact inputs expand into native shapes. Excaliclaude joins the hosted app's collaboration protocol as another peer. Both demonstrate live element edits. T3 can use its existing authenticated RPC instead of an additional canvas server or an externally hosted room. [Canvas client](https://github.com/yctimlin/mcp_excalidraw/blob/81720ac819d2325177cd6137c6ad41d52d0f5374/frontend/src/App.tsx#L870) · [Server](https://github.com/yctimlin/mcp_excalidraw/blob/81720ac819d2325177cd6137c6ad41d52d0f5374/src/server.ts#L442) · [Element expansion](https://github.com/yctimlin/mcp_excalidraw/blob/81720ac819d2325177cd6137c6ad41d52d0f5374/src/core/expand-elements.ts#L70) · [Excaliclaude room](https://github.com/dev-smurf/excaliclaude/blob/a0864eb838847100a21611bff1ff9319aeac5bcc/src/collab.ts#L94)

### Obsidian and VS Code

Obsidian's automation copies existing elements for editing and commits them through its view. The Live Sync add-on hooks `onChange` and exchanges versioned deltas. VS Code hosts the editor in a webview and persists a custom document, including embedded image formats. These validate the host/editor boundary and portable export. Use server-owned mutable state for a closed-panel agent or simultaneous remote users. [Obsidian automation](https://github.com/zsviczian/obsidian-excalidraw-plugin/blob/198b85d53a2af0df63380cbda070adac14fdc4ec/src/shared/ExcalidrawAutomate.ts#L4209) · [Obsidian Live Sync](https://github.com/SHENID1/excalidraw-live-sync/blob/a8d98df5aa1cc3652a292f62d96e91ab500d1396/src/session.ts#L30) · [VS Code webview](https://github.com/excalidraw/excalidraw-vscode/blob/06bb63cea9b52d4759fc16606e95f48c0accf14c/webview/src/App.tsx#L175) · [VS Code document](https://github.com/excalidraw/excalidraw-vscode/blob/06bb63cea9b52d4759fc16606e95f48c0accf14c/src/document.ts#L57)

### T3 forks and extensions

The RyHale fork mounts a project-local Planning board in ChatView behind shared RPC contracts. Its workspace JSON fits planning handoffs. T3 Code Extensions uses Browser for add-on UIs, and Pi tldraw demonstrates a live canvas in that pane. Pi tldraw execution needs a connected widget. A first-party tab and headless writes fit the requirement across providers and avoid a sidecar or webview execution dependency. [Planning panel](https://github.com/RyHale/t3code-planning-fork/blob/fb6244ca7577ab1d88fdd3daea6a85882414f3b6/apps/web/src/components/ChatView.tsx#L3779) · [Planning store](https://github.com/RyHale/t3code-planning-fork/blob/fb6244ca7577ab1d88fdd3daea6a85882414f3b6/apps/server/src/agentBoard/Layers/AgentBoardFileSystem.ts#L17) · [Preview extensions](https://github.com/maddada/t3code-extensions/tree/92881243373816db8bd1266639e55f36e6e0c14c) · [Pi tldraw host](https://github.com/zeekrey/pi-tldraw/blob/ec1e600b11b41e3c421704bc80aff6746a7bf57f/src/host.ts#L205)

A workspace-file-first design would require a policy for writes from external editors and
different worktrees. A peer merge or CRDT becomes more attractive if offline co-editing,
public rooms, or automatic text-level merging is a product requirement. A central commit
lane already orders T3's connected writes and exposes stale edits, without a second
replication protocol.

## Independent design and synthesis

Claude Opus 5.5 independently proposed project-owned named canvases, debounced
`.excalidraw` files in server state, human-priority writes, and compare-and-set agent
writes. It found the upstream plugin and canvas proposal, the sidebar PR action, and the
published package's DOM import failure. Its recommendations sharpened the thread-row
entry, the browser-only import boundary, the geometry and font checks, and the handling of
active gestures and remote undo. The Codex design traced the official MCP and
T3 fork precedents and proposed thread ownership, SQLite receipts, and symmetric per-element
preconditions.

- **Scope and storage.** Thread ownership keeps the sidebar action and the authenticated
  agent's target unambiguous. Claude's project library fits reuse across threads if that
  is a product requirement. A debounce can acknowledge a change before it survives a
  crash. SQLite gives the scene, receipt, and revision one durable commit boundary.
- **Contested edits.** Claude's human-priority rule keeps a drag or text edit intact,
  but a stale full-element write can overwrite a newer property or revive a deletion.
  Keep the local draft visible during the gesture, then check its original token for
  both writers. Keep Claude's observation that a fast-forward uses a precondition and
  that peer nonce tie-breaking is unrelated to author intent.
- **Repair and reconnect.** Claude found Whiteboard MCP restoring inbound records and
  assigning the transmitted versions back to them. That can leave a repaired copy
  with different content under the same token. Keep a separate canonical mirror and
  correct ordering at commit. A reconnect snapshot and durable receipts cover the
  first release with less machinery than an additional replay log.
  [Whiteboard MCP restore adapter](https://github.com/ansuman-shukla/whiteboard-mcp/blob/a30ace0428471bd2674d3fa18102d7e861439c0e/frontend/src/sync.ts#L120-L142)
- **Upstream overlap.** The open upstream plugin proposal includes a distinct canvas
  engine. Its service locks each document, accepts an optional whole-document revision,
  publishes with a client batch ID, and schedules a flush. Reuse the service boundary
  and commit identity ideas. Keep this design independent of that unmerged platform
  and revisit integration if the platform lands before implementation.
  [Upstream proposal](https://github.com/pingdotgg/t3code/pull/40222) ·
  [Canvas write path](https://github.com/pingdotgg/t3code/blob/892e3afb8274e54cc572e97ad2da3bf79a537634/apps/server/src/canvas/CanvasService.ts#L822-L868)

## Release risks

- **Startup and compatibility.** The stable npm release inspected was 0.18.1, with about
  47 MB unpacked across the distributed package. Claude's package probe measured about
  14 MB in production fonts and hit `window is not defined` when importing the bundled
  editor in Node. Measure emitted JS, CSS, and fonts
  separately. Keep the editor and conversion dependencies off the initial chat route and
  load them in a client-only module. Qualify the pinned package against T3's React version,
  production Vite build, Electron packaging, and CSP. Check for cold-load requests before
  the panel opens. [Release](https://www.npmjs.com/package/@excalidraw/excalidraw/v/0.18.1) ·
  [Client-only integration](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/dev-docs/docs/@excalidraw/excalidraw/integration.mdx#L35)
  The 0.18.1 package supports React 19, but its exact Radix Tabs dependency only declares
  support through React 18. The workspace override selects Radix Tabs 1.1.3 for that package.
- **Fonts and shell boundaries.** Package the exact release's fonts under the current web
  asset base and set `EXCALIDRAW_ASSET_PATH` before first editor load. Verify CSS-relative
  fonts, font fallback across scripts, dark mode, clipboard, image download, dialogs,
  pointer input and focus in the real resizable panel. Test with the font CDN blocked,
  including CJK text and the font worker. Set the asset base before first mount and
  verify that the packaged build makes no CDN request for supported fonts.
  [Installation and self-hosted fonts](https://github.com/excalidraw/excalidraw/blob/9c2e462ec23e54c4cf0493328840d6a27191c674/dev-docs/docs/@excalidraw/excalidraw/installation.mdx#L23)
- **Traffic and board growth.** Bound scene, batch, element and file sizes and the tool's
  returned context. Send only changed records after a bounded snapshot and keep drawing
  traffic out of chat. Measure canvas responsiveness, command latency, bytes per gesture and
  idle traffic on a populated board over remote access. Keep board content out of telemetry.
  Route user-supplied image and embedded content through the existing asset and renderer
  trust policies. Keep board files separate from provider attachments.
  [T3 performance budgets](../internals/16_performance-regressions.md) ·
  [Environment auth](../internals/04_environment-auth.md)
- **Package upgrades.** Treat native scene payloads as an external format with a pinned
  compatibility suite. Round-trip saved boards through the next build with a representative
  scene containing layers, arrows, frames, text, images, and tombstones. A client that cannot
  safely round-trip the server format must stay read-only. Verify index repair behavior
  with the shipped build. [Upstream index repair report](https://github.com/excalidraw/excalidraw/issues/11933)

## Phased build and running-app acceptance

1. **Package and panel.** In local web and Electron, open Excalidraw from the sidebar beside a real thread. Draw with the stock toolbar, add a bound arrow and an image, undo, resize and maximize, export, close and reopen. Confirm editor assets appear in the network trace only on first open. Prove the edit capture boundary with slow freehand and IME before proceeding.

2. **Board storage and permissions.** Create, draw, paste an image, and change layers. Wait for saved state, restart the isolated server, and reopen the same board from a second session. Compare geometry, ordering and image. Open another thread and verify you get its own board. Verify an authorized read-only session can see the board and gets a typed rejection on writes.

3. **Two-editor live sync.** Open one board in two paired clients. Create and move different shapes concurrently and verify both edits converge. Drag a shape while the other client edits it. Verify the winner and visible rejection, then recover the losing draft as a copy. Exercise deletion versus stale update, layer reorder with bound text, local undo after a remote commit, duplicate mutation IDs, and a dropped connection immediately after commit. Check that reconnect converges without reapplying or echoing the write.

4. **End-to-end agent edits.** In a real Codex session ask the agent to draw three labeled boxes and two attached arrows. See them appear beside the chat without refresh. Move one box and rename it in the editor. After saved status, ask the same agent to read back the label and bounds and alter one arrow. Verify the live result, repeat with Claude, and have an agent write with the panel closed. Reproduce a deliberate same-ID conflict and verify it rereads and reports what it applied.

5. **Remote and release.** Repeat the agent/user loop against the same server from hosted web and a second paired device, including a tunnel and two environments with separate boards. Run native import/export and a CDN-blocked font check. Compare before/after first-load traffic and profile a busy board. Use the repo's isolated-state app tests and Scenarios for the repeatable flows. Optional agent Mermaid import has its own check with the panel closed.

Use Replay for shell and connection scenarios, plus real providers for tool discovery and
model behavior. See [T3 testing guidance](../internals/15_testing.md).

## Product decisions

- Should the first board belong to a thread, as proposed, or should every thread in a
  project see and edit one shared board? This affects discovery, authorization, and lifecycle.
- Does launch parity cover the packaged editor and T3-paired collaboration, or must it
  include anonymous web links and cross-environment sharing? Those need a separate access model.
