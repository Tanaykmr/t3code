import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as BotTurnContext from "../bots/BotTurnContext.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const deny = (message: string) => new OrchestratorMcpFailure({ code: "invalid_request", message });

type ThreadAncestry = Pick<OrchestrationV2ThreadShell, "lineage"> &
  Partial<Pick<OrchestrationV2ThreadShell, "forkedFrom">>;

// Snapshot ownership once for a list or search, before collecting any results.
export const foreignBotThreads = Effect.fn("BotMcpPolicy.foreignBotThreads")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  scope: McpInvocationScope,
) {
  if (scope.bot !== true) {
    return (_threadId: ThreadId, _known?: ThreadAncestry | null) => Effect.succeed(false);
  }
  const bots = yield* BotTurnContext.optional;
  const privateIds = Option.isNone(bots) ? null : yield* bots.value.privateThreadIds;
  return Effect.fnUntraced(function* (threadId: ThreadId, known?: ThreadAncestry | null) {
    if (privateIds === null) return true;
    const seen = new Set<ThreadId>();
    let current = threadId;
    while (seen.size < 32) {
      if (current !== scope.thread?.threadId && privateIds.has(current)) return true;
      seen.add(current);
      const thread =
        current === threadId && known !== undefined
          ? known
          : yield* threads
              .getThreadShell(current)
              .pipe(Effect.orElseSucceed(() => "unreadable" as const));
      // An ancestor that cannot be checked keeps the fork closed.
      if (thread === "unreadable") return true;
      if (thread === null) return current !== threadId;
      const source =
        thread.forkedFrom?.type === "run"
          ? thread.forkedFrom.threadId
          : thread.lineage.relationshipToParent === "fork"
            ? thread.lineage.parentThreadId
            : null;
      if (source === null) return false;
      if (seen.has(source)) return true;
      current = source;
    }
    return true;
  });
});

export const assertThreadRead = Effect.fn("BotMcpPolicy.assertThreadRead")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  scope: McpInvocationScope,
  threadId: ThreadId,
  known?: ThreadAncestry | null,
) {
  if (scope.bot !== true) return;
  const isForeign = yield* foreignBotThreads(threads, scope);
  if (yield* isForeign(threadId, known)) {
    return yield* deny("That thread belongs to a bot and is private.");
  }
});

const dmContext = Effect.fn("BotMcpPolicy.dmContext")(function* (scope: McpInvocationScope) {
  const bots = yield* BotTurnContext.optional;
  const threadId = scope.thread?.threadId;
  return threadId !== undefined && Option.isSome(bots) && (yield* bots.value.isDm(threadId))
    ? { threadId, bots: bots.value }
    : undefined;
});

export const routineVisibility = Effect.fn("BotMcpPolicy.routineVisibility")(function* (
  scope: McpInvocationScope,
) {
  if (scope.bot !== true) return (_threadId: ThreadId | null) => true;
  const dm = yield* dmContext(scope);
  return (threadId: ThreadId | null) => dm !== undefined && threadId === dm.threadId;
});

const operatorRequired = "A bot can make this change only when the user asks in its own chat.";

const assertOperatorDm = Effect.fn("BotMcpPolicy.assertOperatorDm")(function* (
  scope: McpInvocationScope,
) {
  if (scope.bot !== true) return;
  const dm = yield* dmContext(scope);
  if (dm === undefined || !(yield* dm.bots.isOperatorTurn(dm.threadId))) {
    return yield* deny(operatorRequired);
  }
  return dm.threadId;
});

export const assertThreadWrite = Effect.fn("BotMcpPolicy.assertThreadWrite")(function* (
  scope: McpInvocationScope,
  threadId: ThreadId,
) {
  if (scope.bot !== true) return;
  if (threadId !== scope.thread?.threadId) {
    return yield* deny(
      "A bot can only control its own chat. Use delegate_task to start coding work.",
    );
  }
  yield* assertOperatorDm(scope);
});

export const authorizeRoutine = Effect.fn("BotMcpPolicy.authorizeRoutine")(function* (
  scope: McpInvocationScope,
  callerProjectId: ProjectId | undefined,
  routine: Pick<ScheduledTask, "threadId" | "projectId">,
) {
  const threadId = yield* assertOperatorDm(scope);
  if (threadId === undefined) return {};
  if (routine.threadId !== threadId || routine.projectId !== callerProjectId) {
    return yield* deny("A bot can change or run only routines bound to its own chat and project.");
  }
  return { requiredThreadId: threadId };
});

const botDenials = {
  launch:
    "A bot starts coding work with delegate_task, which keeps it to the projects the user allowed.",
  transfer: "A bot cannot transfer thread context. Use delegate_task for side work.",
  handoff: "Use delegate_task with worktree isolation to start coding work.",
  steer: "Use delegate_task to start coding work. A person can send queued messages as steering.",
  send: "Use delegate_task to start coding work or t3_bot_message to message another bot.",
  remote: "A bot can work only in its configured local work targets. Use delegate_task there.",
  workflow: "A bot can change work only through delegate_task in its configured work targets.",
  project: "A bot makes project changes through delegate_task in its configured work targets.",
  environment: "A person must change environment settings and projects.",
  respond: "A person must answer the bot's pending request.",
} as const;

export const assertNonBot = (
  scope: McpInvocationScope,
  action: keyof typeof botDenials,
): Effect.Effect<void, OrchestratorMcpFailure> =>
  scope.bot === true ? Effect.fail(deny(botDenials[action])) : Effect.void;

export const assertNoAgentInput = Effect.fn("BotMcpPolicy.assertNoAgentInput")(function* (
  threadId: ThreadId,
  action: "send" | "edit",
) {
  // A queued edit keeps the original author. Generic sends skip membership and hop checks.
  const bots = yield* BotTurnContext.optional;
  if (Option.isNone(bots)) return;
  const privateIds = yield* bots.value.privateThreadIds;
  if (privateIds !== null && !privateIds.has(threadId)) return;
  return yield* deny(
    action === "edit"
      ? "Queued messages in a bot's chat cannot be edited by an agent."
      : "That thread belongs to a bot. Bots reach each other with t3_bot_message; agents cannot send into a bot's chat directly.",
  );
});

export const assertDelegationTarget = Effect.fn("BotMcpPolicy.assertDelegationTarget")(function* (
  scope: McpInvocationScope,
  homeProjectId: ProjectId,
  projectId: ProjectId,
  isolation: "shared" | "worktree" | undefined,
) {
  const crossProject = projectId !== homeProjectId;
  if (scope.bot !== true) {
    if (!crossProject) return;
    return yield* deny(
      "A local task runs in this thread's project. Omit target.projectId, or pass target.environmentId to run it in that environment's project.",
    );
  }
  const bots = yield* BotTurnContext.optional;
  const threadId = scope.thread?.threadId;
  const allowed =
    threadId !== undefined && Option.isSome(bots) ? yield* bots.value.workTargets(threadId) : null;
  if (!allowed?.includes(projectId)) {
    return yield* deny(
      "The user has not allowed this bot to work in that project. Ask them to add it to your work targets.",
    );
  }
  if (crossProject && isolation !== "worktree") {
    return yield* deny('A task in another project needs isolation "worktree".');
  }
});
