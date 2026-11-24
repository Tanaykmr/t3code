import {
  BotId,
  type BotCreateInput,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotService from "./BotService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const launches: Array<string> = [];
const threadStatus = { current: "idle" };
const dispatched: Array<string> = [];

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const launchMock = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
  launch: (input) =>
    Effect.sync(() => {
      launches.push(input.commandId);
      // Like the real service, a repeated command returns the thread it already made.
      return {
        threadId: ThreadId.make(`dm-${input.commandId}`),
        projection: {} as never,
        resumed: false,
      };
    }),
});
const threadsMock = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadShell: () => Effect.sync(() => ({ status: threadStatus.current }) as never),
  dispatch: (command) =>
    Effect.sync(() => {
      dispatched.push(command.type);
      return {} as never;
    }),
});
const layer = it.layer(
  Layer.mergeAll(
    BotService.layer.pipe(Layer.provide(Layer.mergeAll(database, launchMock, threadsMock))),
    BotTurnContext.layer.pipe(Layer.provide(database)),
  ),
);

const createInput = (botId: string, name: string, persona: string): BotCreateInput => ({
  botId: BotId.make(botId),
  name,
  title: "Reviewer",
  avatar: "compass",
  persona,
  projectId: ProjectId.make("project-a"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
});

layer("BotService", (it) => {
  it.effect("creates two bots with their own DM and persona, and retries without duplicates", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const context = yield* BotTurnContext.BotTurnContext;
      const ada = yield* bots.create(createInput("bot-ada", "Ada", "Terse. Prefers tests."));
      const bolt = yield* bots.create(createInput("bot-bolt", "Bolt", "Chatty. Loves diagrams."));
      const retried = yield* bots.create(createInput("bot-ada", "Ada", "ignored"));

      assert.notStrictEqual(ada.bot.dmThreadId, bolt.bot.dmThreadId);
      assert.strictEqual(retried.bot.dmThreadId, ada.bot.dmThreadId);
      assert.strictEqual(retried.bot.persona, "Terse. Prefers tests.");
      assert.deepEqual(launches, ["bot-dm:bot-ada", "bot-dm:bot-bolt"]);

      const adaContext = yield* context.forThread(ada.bot.dmThreadId);
      assert.match(adaContext[0]?.text ?? "", /You are Ada, Reviewer/);
      assert.match(adaContext[0]?.text ?? "", /Terse\. Prefers tests\./);
      assert.deepEqual(yield* context.forThread(ThreadId.make("ordinary-thread")), []);

      const unqualified = yield* bots
        .create({
          ...createInput("bot-cursor", "Cursory", ""),
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "auto" },
        })
        .pipe(Effect.flip);
      assert.match(unqualified.message, /Codex or Claude/);
      // Switching a bot's chat to another provider is refused too; ordinary threads are not.
      const switched = yield* bots
        .assertThreadProvider(ada.bot.dmThreadId, "cursor")
        .pipe(Effect.flip);
      assert.match(switched.message, /Codex or Claude/);
      yield* bots.assertThreadProvider(ada.bot.dmThreadId, "claudeAgent");
      yield* bots.assertThreadProvider(ThreadId.make("ordinary-thread"), "cursor");

      const duplicate = yield* bots.create(createInput("bot-other", "ada", "")).pipe(Effect.flip);
      assert.match(duplicate.message, /already named ada/);

      const updated = yield* bots.update({ botId: ada.bot.id, persona: "Now formal." });
      assert.strictEqual(updated.bot.personaRevision, 2);
      assert.match((yield* context.forThread(ada.bot.dmThreadId))[0]?.text ?? "", /Now formal\./);
    }),
  );

  it.effect("archives only a quiet bot and restores the same DM", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const seen = yield* Ref.make(0);
      const created = yield* bots.create(createInput("bot-cora", "Cora", ""));

      threadStatus.current = "running";
      const busy = yield* bots.archive({ botId: created.bot.id }).pipe(Effect.flip);
      assert.match(busy.message, /still working/);

      threadStatus.current = "idle";
      const archived = yield* bots.archive({ botId: created.bot.id });
      assert.isNotNull(archived.bot.archivedAt);
      // An archived bot's name is free again until it is restored.
      yield* bots.create(createInput("bot-cora-2", "Cora", ""));
      const blocked = yield* bots.restore({ botId: created.bot.id }).pipe(Effect.flip);
      assert.match(blocked.message, /already named Cora/);
      yield* bots.archive({ botId: BotId.make("bot-cora-2") });
      const restored = yield* bots.restore({ botId: created.bot.id });
      assert.isNull(restored.bot.archivedAt);
      assert.strictEqual(restored.bot.dmThreadId, created.bot.dmThreadId);
      // The DM is archived and restored with its bot.
      assert.includeMembers(dispatched, ["thread.archive", "thread.unarchive"]);

      const directory = yield* bots.subscribeDirectory().pipe(
        Stream.tap(() => Ref.update(seen, (count) => count + 1)),
        Stream.take(1),
        Stream.runCollect,
      );
      const names = directory[0]?.bots.map((bot) => `${bot.name}:${bot.archivedAt === null}`);
      assert.includeMembers(names ?? [], ["Cora:true", "Cora:false"]);
      assert.strictEqual(yield* Ref.get(seen), 1);
    }),
  );
});
