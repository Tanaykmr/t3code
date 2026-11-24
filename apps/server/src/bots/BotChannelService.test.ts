import {
  BotId,
  BotMessageId,
  BotRoomId,
  type BotCreateInput,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotChannelService from "./BotChannelService.ts";
import * as BotService from "./BotService.ts";

const sends: Array<{
  threadId: string;
  text: string;
  commandId: string;
  modelSelection: ModelSelection | undefined;
}> = [];
const dmModels = new Map<string, ModelSelection>();
const busyThreads = new Set<string>();
const modeChanges: Array<string> = [];
const pausedSends = new Map<string, (threadId: ThreadId) => Effect.Effect<void>>();

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const launchMock = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
  launch: (input) =>
    Effect.succeed({
      threadId: ThreadId.make(`thread-${input.commandId}`),
      projection: {} as never,
      resumed: false,
    }),
});
// Shares the test database, where a sent message's reply lands like the real projection's.
const threadsMock = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          projectId: ProjectId.make("project-a"),
          status: busyThreads.has(threadId) ? "running" : "idle",
          runtimeMode: threadId === "thread-bot-dm:cora" ? "approval-required" : "full-access",
          interactionMode: "default",
          modelSelection: dmModels.get(threadId) ?? {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
        } as never),
      hasReceipt: () => Effect.succeed(false),
      dispatch: (command) =>
        Effect.sync(() => {
          modeChanges.push(command.type);
          return {} as never;
        }),
      sendToThread: (input) =>
        Effect.gen(function* () {
          const pause = pausedSends.get(input.commandId);
          if (pause !== undefined) yield* pause(input.threadId);
          sends.push({
            threadId: input.threadId,
            text: input.text,
            commandId: input.commandId,
            modelSelection: input.modelSelection,
          });
          const runId = `run-${input.commandId}`;
          const payload = JSON.stringify({ text: `reply from ${input.threadId}` });
          yield* sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${`msg-${runId}`}, ${input.threadId}, ${runId}, 'assistant', 0, 'now', 'now', ${payload})
      `.pipe(Effect.orDie);
          return { run: { id: RunId.make(runId) } } as never;
        }),
      waitForThread: (input) =>
        Effect.succeed({
          threadId: input.threadId,
          timedOut: false,
          run: { id: input.runId, status: "completed" },
        } as never),
    }),
  ),
);
const services = Layer.mergeAll(launchMock, threadsMock).pipe(Layer.provideMerge(database));
const botsLayer = BotService.layer.pipe(Layer.provide(services));
const layer = it.layer(
  Layer.mergeAll(
    BotChannelService.layer.pipe(Layer.provide(Layer.merge(botsLayer, services))),
    botsLayer,
    database,
  ),
);

const bot = (id: string, name: string): BotCreateInput => ({
  botId: BotId.make(id),
  name,
  title: "",
  avatar: "bot",
  persona: "",
  projectId: ProjectId.make("project-a"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
});

/** Lets the delivery worker and its waiters run to quiet. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
  yield* TestClock.adjust("4 seconds");
  for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
});

layer("BotChannelService", (it) => {
  it.effect("fails when bot thread ownership cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const channels = yield* BotChannelService.BotChannelService;
      const threadId = ThreadId.make("thread-without-a-bot");
      assert.strictEqual(yield* channels.isBotThread(threadId), false);

      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`ALTER TABLE bot_room_threads RENAME TO unavailable_bot_room_threads`;
          const result = yield* Effect.exit(channels.isBotThread(threadId));
          yield* sql`ALTER TABLE unavailable_bot_room_threads RENAME TO bot_room_threads`;
          return result;
        }),
      );
      assert.isTrue(Exit.isFailure(result));
    }),
  );

  it.effect("routes room posts by chip or to the default responder, once per recipient", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_runs (
          run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
          status TEXT NOT NULL, payload_json TEXT NOT NULL
        )
      `;
      yield* sql`
        CREATE TABLE orchestration_v2_projection_messages (
          message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT,
          role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, payload_json TEXT NOT NULL
        )
      `;
      const bots = yield* BotService.BotService;
      const channels = yield* BotChannelService.BotChannelService;
      for (const [id, name] of [
        ["ada", "Ada"],
        ["bolt", "Bolt"],
        ["cora", "Cora"],
      ] as const) {
        yield* bots.create(bot(id, name));
      }
      const roomId = BotRoomId.make("release");
      yield* channels.createRoom({
        roomId,
        name: "Release room",
        memberBotIds: [BotId.make("ada"), BotId.make("bolt"), BotId.make("cora")],
        defaultBotId: BotId.make("ada"),
      });

      const mentioned = {
        roomId,
        messageId: BotMessageId.make("m1"),
        text: "Bolt and Cora, check the cache.",
        mentions: [
          { botId: BotId.make("bolt"), label: "Bolt" },
          { botId: BotId.make("cora"), label: "Cora" },
        ],
      };
      yield* channels.sendRoomMessage(mentioned);
      // The same message again wakes nobody twice.
      yield* channels.sendRoomMessage(mentioned);
      yield* settle;
      assert.deepEqual(sends.map((send) => send.commandId).toSorted(), [
        "bot-delivery:m1:bolt",
        "bot-delivery:m1:cora",
      ]);
      assert.match(sends[0]!.text, /room "Release room"/);

      yield* channels.sendRoomMessage({
        roomId,
        messageId: BotMessageId.make("m2"),
        text: "Anyone?",
        mentions: [],
      });
      yield* settle;
      assert.strictEqual(sends.at(-1)?.commandId, "bot-delivery:m2:ada");

      const room = yield* channels
        .subscribeChannel({ kind: "room", roomId })
        .pipe(Stream.take(1), Stream.runCollect);
      const messages = room[0]!.messages;
      // Each answer is posted once, as its bot, in reply to the post that woke it.
      const replies = messages.filter((message) => message.sender.kind === "bot");
      assert.strictEqual(replies.length, 3);
      assert.ok(replies.every((reply) => reply.replyToId !== null));
      assert.ok(room[0]!.deliveries.every((delivery) => delivery.status === "settled"));
      // Cora's DM asks for approval, so her room seat is brought down to match before it runs.
      assert.include(modeChanges, "thread.runtime-mode.set");
    }),
  );

  it.effect("a removed member's queued delivery never starts", () =>
    Effect.gen(function* () {
      const channels = yield* BotChannelService.BotChannelService;
      const roomId = BotRoomId.make("release");
      const coraSeat = "thread-bot-room:release:cora";
      busyThreads.add(coraSeat);
      const before = sends.length;
      yield* channels.sendRoomMessage({
        roomId,
        messageId: BotMessageId.make("m3"),
        text: "Cora, one more thing.",
        mentions: [{ botId: BotId.make("cora"), label: "Cora" }],
      });
      yield* settle;
      assert.strictEqual(sends.length, before);
      yield* channels.updateRoom({
        roomId,
        memberBotIds: [BotId.make("ada"), BotId.make("bolt")],
      });
      busyThreads.delete(coraSeat);
      yield* settle;
      assert.strictEqual(sends.length, before);
      const room = yield* channels
        .subscribeChannel({ kind: "room", roomId })
        .pipe(Stream.take(1), Stream.runCollect);
      const blocked = room[0]!.deliveries.find((delivery) => delivery.messageId === "m3");
      assert.strictEqual(blocked?.status, "blocked");
      assert.strictEqual(blocked?.reason, "Removed from the room");
    }),
  );

  it.effect("a bot's message to a peer wakes it, and the answer resumes the sender once", () =>
    Effect.gen(function* () {
      const channels = yield* BotChannelService.BotChannelService;
      const before = sends.length;
      const sql = yield* SqlClient.SqlClient;
      // Ada is in a turn the user started.
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, status, payload_json)
        VALUES ('ada-turn', 'thread-bot-dm:ada', 1, 'running', '{"userMessageId":"user-1"}')
      `;
      const sent = yield* channels.sendFromThread({
        threadId: ThreadId.make("thread-bot-dm:ada"),
        to: "@bolt",
        text: "Please review the cache fix.",
      });
      yield* settle;
      const woken = sends.slice(before).map((send) => send.threadId);
      // Bolt is woken in its peer seat, never its private DM; Ada's DM gets the answer once.
      assert.deepEqual(woken, ["thread-bot-peer:bolt", "thread-bot-dm:ada"]);
      assert.match(sends.at(-1)!.text, /needs no reply/);
      assert.strictEqual(sent.message.channelKey, "peer:ada:bolt");

      const unknown = yield* channels
        .sendFromThread({ threadId: ThreadId.make("not-a-bot"), to: "Bolt", text: "hi" })
        .pipe(Effect.flip);
      assert.match(unknown.message, /Only a bot/);
    }),
  );

  it.effect("a bot never wakes a bot that runs with more access than it has", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const channels = yield* BotChannelService.BotChannelService;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, status, payload_json)
        VALUES ('cora-turn', 'thread-bot-dm:cora', 1, 'running', '{"userMessageId":"user-2"}')
      `;
      const before = sends.length;
      // Cora asks for approval on every action; Bolt runs with full access.
      const sent = yield* channels.sendFromThread({
        threadId: ThreadId.make("thread-bot-dm:cora"),
        to: "Bolt",
        text: "Delete the cache directory.",
      });
      yield* settle;
      assert.strictEqual(sends.length, before);
      const exchange = yield* channels
        .subscribeChannel({ kind: "bot", botId: BotId.make("cora") })
        .pipe(Stream.take(1), Stream.runCollect);
      const delivery = exchange[0]!.deliveries.find((d) => d.messageId === sent.message.id);
      assert.strictEqual(delivery?.status, "blocked");
      assert.match(delivery?.reason ?? "", /more access/);
    }),
  );
  it.effect("uses the DM's current model for existing peer and room seats", () =>
    Effect.gen(function* () {
      const channels = yield* BotChannelService.BotChannelService;
      const before = sends.length;
      const boltId = BotId.make("bolt");
      const boltDm = "thread-bot-dm:bolt";
      const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" };
      dmModels.set(boltDm, selection);
      yield* Effect.addFinalizer(() => Effect.sync(() => dmModels.delete(boltDm)));
      yield* channels.sendRoomMessage({
        roomId: BotRoomId.make("release"),
        messageId: BotMessageId.make("current-model"),
        text: "Check this release.",
        mentions: [{ botId: boltId, label: "Bolt" }],
      });
      yield* channels.sendFromThread({
        threadId: ThreadId.make("thread-bot-dm:ada"),
        to: "Bolt",
        text: "Check this patch.",
      });
      yield* settle;
      assert.deepEqual(
        sends
          .slice(before)
          .filter((send) => send.threadId.endsWith(":bolt"))
          .map((send) => [send.threadId, send.modelSelection]),
        [
          ["thread-bot-room:release:bolt", selection],
          ["thread-bot-peer:bolt", selection],
        ],
      );
    }),
  );

  it.effect("archives only after an in-flight delivery has started", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const channels = yield* BotChannelService.BotChannelService;
      const roomId = BotRoomId.make("release");
      const boltId = BotId.make("bolt");
      const starting = yield* Deferred.make<ThreadId>();
      const resume = yield* Deferred.make<void>();
      const commandId = "bot-delivery:archive-race:bolt";
      pausedSends.set(commandId, (threadId) =>
        Deferred.succeed(starting, threadId).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.tap(() => Effect.sync(() => busyThreads.add(threadId))),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          pausedSends.delete(commandId);
          busyThreads.delete("thread-bot-room:release:bolt");
        }),
      );
      yield* channels.sendRoomMessage({
        roomId,
        messageId: BotMessageId.make("archive-race"),
        text: "Bolt, check the release.",
        mentions: [{ botId: boltId, label: "Bolt" }],
      });
      yield* Deferred.await(starting);
      const archival = yield* bots
        .archive({ botId: boltId })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Fiber.join(archival);
      assert.ok(result._tag === "Failure");
      assert.match(result.failure.message, /still working/);
    }),
  );

  it.effect("orders room sends behind a queued default change", () =>
    Effect.gen(function* () {
      const channels = yield* BotChannelService.BotChannelService;
      const sql = yield* SqlClient.SqlClient;
      const roomId = BotRoomId.make("release");
      const boltId = BotId.make("bolt");
      const reachedSend = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const commandId = "bot-delivery:update-race:ada";
      pausedSends.set(commandId, () =>
        Deferred.succeed(reachedSend, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => pausedSends.delete(commandId)));
      yield* channels.sendRoomMessage({
        roomId,
        messageId: BotMessageId.make("update-race"),
        text: "Wait here.",
        mentions: [],
      });
      yield* Deferred.await(reachedSend);
      const update = yield* channels
        .updateRoom({ roomId, defaultBotId: boltId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const post = yield* channels
        .sendRoomMessage({
          roomId,
          messageId: BotMessageId.make("after-update"),
          text: "Who is on call?",
          mentions: [],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(update);
      yield* Fiber.join(post);
      const deliveries = yield* sql<{ target_bot_id: string }>`
        SELECT target_bot_id FROM bot_deliveries WHERE message_id = 'after-update'
      `;
      assert.deepEqual(
        deliveries.map((delivery) => delivery.target_bot_id),
        [boltId],
      );
    }),
  );

  it.effect("routes an unmentioned post to an active member after the default is archived", () =>
    Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      const channels = yield* BotChannelService.BotChannelService;
      const sql = yield* SqlClient.SqlClient;
      const { bot: alternate } = yield* bots.create(bot("alternate", "Alternate"));
      const { bot: primary } = yield* bots.create(bot("primary", "Primary"));
      const roomId = BotRoomId.make("archived-default");
      yield* channels.createRoom({
        roomId,
        name: "Support",
        memberBotIds: [alternate.id, primary.id],
        defaultBotId: primary.id,
      });
      yield* bots.archive({ botId: primary.id });
      yield* channels.sendRoomMessage({
        roomId,
        messageId: BotMessageId.make("fallback"),
        text: "Who can help?",
        mentions: [],
      });
      const deliveries = yield* sql<{ target_bot_id: string }>`
        SELECT target_bot_id FROM bot_deliveries WHERE message_id = 'fallback'
      `;
      assert.deepEqual(
        deliveries.map((delivery) => delivery.target_bot_id),
        [alternate.id],
      );
    }),
  );
});
