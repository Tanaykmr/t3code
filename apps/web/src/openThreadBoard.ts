import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { boardEnvironment } from "./state/board";
import { readEnvironmentScope } from "./state/session";

/** Opening the board from an explicit action creates it; reopening a closed panel does not. */
export function openThreadBoard(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().open(threadRef, "excalidraw");
  if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
  // An older server without boards says so in the panel instead.
  void runAtomCommand(
    appAtomRegistry,
    boardEnvironment.create,
    { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } },
    { reportFailure: false },
  );
}
