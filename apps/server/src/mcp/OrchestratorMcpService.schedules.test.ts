import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotTurnContext from "../bots/BotTurnContext.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as Mcp from "./OrchestratorMcpService.ts";

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  NodeServices.layer,
  Sqlite.layerMemory,
  ServerSettings.layerTest(),
  ManagedPolicy.layerTest(),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  Layer.mock(Projects.ProjectService)({}),
  Layer.mock(Providers.ProviderRegistry)({}),
  Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({}),
  Layer.mock(Threads.ThreadManagementService)({}),
  Layer.mock(Launch.ThreadLaunchService)({}),
  Layer.mock(Git.GitVcsDriver)({}),
  Layer.mock(Secrets.SecretRequests)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
);

const client: McpInvocationScope = {
  environmentId: EnvironmentId.make("schedule-test"),
  requestNamespace: "client",
  thread: undefined,
  client: { sessionId: "client", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const fixture = Effect.gen(function* () {
  const schedules = yield* Schedules.ScheduledTaskService;
  const { task } = yield* schedules.upsert({
    title: "Scheduled review",
    prompt: "Review",
    projectId: ProjectId.make("project"),
    schedule: { type: "interval", everyMs: 60_000 },
    enabled: true,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  return { schedules, id: task.id };
});

const layer = Schedules.layer.pipe(Layer.provideMerge(dependencies));

it.effect("an MCP edit cannot recreate a concurrently deleted schedule", () =>
  Effect.gen(function* () {
    const { schedules, id } = yield* fixture;
    const editing = {
      ...schedules,
      list: () => schedules.list().pipe(Effect.tap(() => schedules.delete({ id }))),
    };
    const result = yield* Mcp.OrchestratorMcpService.pipe(
      Effect.flatMap((mcp) =>
        mcp.updateScheduledTask(client, { scheduledTaskId: id, enabled: false }),
      ),
      Effect.provide(Mcp.layer),
      Effect.provideService(Schedules.ScheduledTaskService, editing),
      Effect.result,
    );
    expect((yield* schedules.list()).tasks).toEqual([]);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("a bot deletes its routine only on the user's own request", () =>
  Effect.gen(function* () {
    const { schedules, id } = yield* fixture;
    const dm = ThreadId.make("bot-dm");
    const bound = {
      ...schedules,
      list: () =>
        schedules.list().pipe(
          Effect.map(({ tasks }) => ({
            tasks: tasks.map((task) => ({ ...task, threadId: dm })),
          })),
        ),
    };
    const botScope: McpInvocationScope = {
      ...client,
      client: undefined,
      thread: {
        threadId: dm,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      bot: true,
    };
    const result = yield* Mcp.OrchestratorMcpService.pipe(
      Effect.flatMap((mcp) => mcp.deleteScheduledTask(botScope, { scheduledTaskId: id })),
      Effect.provide(Mcp.layer),
      Effect.provideService(Schedules.ScheduledTaskService, bound),
      Effect.provideService(BotTurnContext.BotTurnContext, {
        forThread: () => Effect.succeed([]),
        workTargets: () => Effect.succeed(["project"]),
        isDm: () => Effect.succeed(true),
        // A routine's own turn, not the user's.
        isOperatorTurn: () => Effect.succeed(false),
      }),
      Effect.provideService(Threads.ThreadManagementService, {
        getThreadShell: () => Effect.succeed(null),
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: dm,
              projectId: ProjectId.make("project"),
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            runs: [],
          }),
      } as never),
      Effect.flip,
    );
    expect(result.message).toMatch(/only when the user asks/);
    expect((yield* schedules.list()).tasks.map((task) => task.id)).toEqual([id]);
  }).pipe(Effect.provide(layer)),
);
