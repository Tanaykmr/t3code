import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ensureBotSchema } from "../bots/botStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";

const database = SqlitePersistence.layerMemory;
const codex = ProviderInstanceId.make("codex");
const cursor = ProviderInstanceId.make("cursor");
const adapter = (instanceId: ProviderInstanceId): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Provider changes do not need a running session"),
});

const layer = Layer.merge(
  database,
  ProviderReplayHarness.layerWithRegistry(
    { name: "bot-provider-dispatch" },
    ProviderAdapterRegistry.layerFromAdapters([adapter(codex), adapter(cursor)]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("restricts model changes on bot DMs, peer chats and room seats in command dispatch", () =>
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const dm = ThreadId.make("bot-dm");
    const peer = ThreadId.make("bot-peer");
    const seat = ThreadId.make("bot-seat");
    const ordinary = ThreadId.make("ordinary");
    yield* ensureBotSchema;
    for (const threadId of [dm, peer, seat, ordinary]) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:bot-provider-dispatch"),
        title: threadId,
        modelSelection: { instanceId: codex, model: "original" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* sql`
      INSERT INTO bots (bot_id, name, title, avatar, persona, persona_revision, project_id,
        model_selection_json, dm_thread_id, peer_thread_id, created_at, updated_at)
      VALUES ('ada', 'Ada', '', '{}', '', 1, 'project:bot-provider-dispatch', '{}', ${dm}, ${peer}, 'now', 'now')
    `;
    yield* sql`INSERT INTO bot_room_threads (room_id, bot_id, thread_id) VALUES ('room', 'ada', ${seat})`;

    const modelSelection = { instanceId: cursor, model: "auto" };
    const commands: ReadonlyArray<OrchestrationV2ServerCommand> = [
      {
        type: "provider.switch",
        commandId: CommandId.make("configure"),
        threadId: dm,
        modelSelection,
      },
      {
        type: "thread.model-selection.set",
        commandId: CommandId.make("select"),
        threadId: peer,
        modelSelection,
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("send"),
        threadId: seat,
        messageId: MessageId.make("input"),
        text: "Hello",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      },
    ];
    for (const command of commands) {
      const result = yield* engine.dispatch(command).pipe(Effect.result);
      assert.ok(result._tag === "Failure", `${command.type} should reject Cursor`);
      assert.match(
        userFacingDispatchErrorMessage(result.failure) ?? "",
        /Bots run on Codex or Claude/,
      );
    }

    yield* engine.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("allowed-model"),
      threadId: dm,
      modelSelection: { instanceId: codex, model: "updated" },
    });
    yield* engine.dispatch({
      type: "provider.switch",
      commandId: CommandId.make("ordinary-switch"),
      threadId: ordinary,
      modelSelection,
    });
    assert.strictEqual(
      (yield* engine.getThreadRecords(dm, [])).thread.modelSelection.model,
      "updated",
    );
    assert.strictEqual((yield* engine.getThreadRecords(peer, [])).thread.providerInstanceId, codex);
    assert.strictEqual((yield* engine.getThreadRecords(seat, [])).thread.providerInstanceId, codex);
    assert.strictEqual(
      (yield* engine.getThreadRecords(ordinary, [])).thread.providerInstanceId,
      cursor,
    );
  }).pipe(Effect.provide(layer)),
);
