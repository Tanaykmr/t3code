import {
  BotError,
  BotKnowledge,
  type BotId,
  type BotKnowledgeDeleteInput,
  type BotMemorySaveInput,
  type BotSkillSaveInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureBotSchema, executingTurnOrigin } from "./botStore.ts";

/** Memories and skills a bot keeps across sessions; the persona context reads them. */
export class BotKnowledgeService extends Context.Service<
  BotKnowledgeService,
  {
    readonly subscribe: (botId: BotId) => Stream.Stream<BotKnowledge, BotError>;
    readonly saveMemory: (input: BotMemorySaveInput) => Effect.Effect<BotKnowledge, BotError>;
    readonly saveSkill: (input: BotSkillSaveInput) => Effect.Effect<BotKnowledge, BotError>;
    readonly remove: (input: BotKnowledgeDeleteInput) => Effect.Effect<BotKnowledge, BotError>;
    /**
     * A bot saves a lasting preference from its own DM. A turn another bot or a room
     * woke cannot write memory, so nothing a peer says becomes the user's preference.
     */
    readonly rememberFromThread: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<{ readonly memoryId: string }, BotError>;
    readonly forgetFromThread: (input: {
      readonly threadId: ThreadId;
      readonly memoryId: string;
    }) => Effect.Effect<void, BotError>;
  }
>()("t3/bots/BotKnowledgeService") {}

interface MemoryRow {
  readonly memory_id: string;
  readonly bot_id: string;
  readonly text: string;
  readonly source: string;
  readonly source_thread_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SkillRow {
  readonly skill_id: string;
  readonly bot_id: string;
  readonly name: string;
  readonly instructions: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeKnowledge = Schema.decodeUnknownEffect(BotKnowledge);
const isBotError = Schema.is(BotError);
const botError = (message: string) => (cause: unknown) => new BotError({ message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureBotSchema;
  const changes = yield* PubSub.sliding<string>(16);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const read = Effect.fn("BotKnowledgeService.read")(function* (botId: string) {
    const memories = yield* sql<MemoryRow>`
      SELECT * FROM bot_memories WHERE bot_id = ${botId} ORDER BY updated_at DESC
    `;
    const skills = yield* sql<SkillRow>`
      SELECT * FROM bot_skills WHERE bot_id = ${botId} ORDER BY created_at
    `;
    return yield* decodeKnowledge({
      memories: memories.map((row) => ({
        id: row.memory_id,
        botId: row.bot_id,
        text: row.text,
        source: row.source,
        sourceThreadId: row.source_thread_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      skills: skills.map((row) => ({
        id: row.skill_id,
        botId: row.bot_id,
        name: row.name,
        instructions: row.instructions,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  });
  const readFor = (botId: string) =>
    read(botId).pipe(Effect.mapError(botError("Could not read the bot's memory.")));

  const requireBot = Effect.fn("BotKnowledgeService.requireBot")(function* (botId: string) {
    const rows = yield* sql`SELECT bot_id FROM bots WHERE bot_id = ${botId}`.pipe(
      Effect.mapError(botError("Could not read the bot.")),
    );
    if (rows.length === 0) return yield* new BotError({ message: "That bot no longer exists." });
  });

  const writeMemory = Effect.fn("BotKnowledgeService.writeMemory")(function* (input: {
    readonly botId: string;
    readonly memoryId: string;
    readonly text: string;
    readonly source: "user" | "bot";
    readonly sourceThreadId: string | null;
  }) {
    const at = yield* now;
    yield* sql`
      INSERT INTO bot_memories (memory_id, bot_id, text, source, source_thread_id, created_at, updated_at)
      VALUES (${input.memoryId}, ${input.botId}, ${input.text}, ${input.source},
        ${input.sourceThreadId}, ${at}, ${at})
      ON CONFLICT (memory_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      WHERE bot_memories.bot_id = excluded.bot_id
    `.pipe(Effect.mapError(botError("Could not save the memory.")));
    yield* PubSub.publish(changes, input.botId);
  });

  const subscribe: BotKnowledgeService["Service"]["subscribe"] = (botId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(readFor(botId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === botId),
            Stream.mapEffect(() => readFor(botId)),
          ),
        );
      }),
    );

  const saveMemory: BotKnowledgeService["Service"]["saveMemory"] = Effect.fn(
    "BotKnowledgeService.saveMemory",
  )(function* (input) {
    yield* requireBot(input.botId);
    yield* writeMemory({
      botId: input.botId,
      memoryId: input.memoryId,
      text: input.text,
      source: "user",
      sourceThreadId: null,
    });
    return yield* readFor(input.botId);
  });

  const saveSkill: BotKnowledgeService["Service"]["saveSkill"] = Effect.fn(
    "BotKnowledgeService.saveSkill",
  )(function* (input) {
    yield* requireBot(input.botId);
    const at = yield* now;
    yield* sql`
      INSERT INTO bot_skills (skill_id, bot_id, name, instructions, enabled, created_at, updated_at)
      VALUES (${input.skillId}, ${input.botId}, ${input.name}, ${input.instructions},
        ${input.enabled ? 1 : 0}, ${at}, ${at})
      ON CONFLICT (skill_id) DO UPDATE SET name = excluded.name,
        instructions = excluded.instructions, enabled = excluded.enabled,
        updated_at = excluded.updated_at
      WHERE bot_skills.bot_id = excluded.bot_id
    `.pipe(Effect.mapError(botError("Could not save the skill.")));
    yield* PubSub.publish(changes, input.botId);
    return yield* readFor(input.botId);
  });

  const remove: BotKnowledgeService["Service"]["remove"] = Effect.fn("BotKnowledgeService.remove")(
    function* (input) {
      if (input.kind === "memory") {
        yield* sql`DELETE FROM bot_memories WHERE memory_id = ${input.id} AND bot_id = ${input.botId}`;
      } else {
        yield* sql`DELETE FROM bot_skills WHERE skill_id = ${input.id} AND bot_id = ${input.botId}`;
      }
      yield* PubSub.publish(changes, input.botId);
      return yield* readFor(input.botId);
    },
    Effect.mapError((cause) =>
      isBotError(cause) ? cause : new BotError({ message: "Could not delete.", cause }),
    ),
  );

  /** The bot whose DM this is, refusing a turn another bot or a room woke. */
  const dmOwner = Effect.fn("BotKnowledgeService.dmOwner")(function* (threadId: ThreadId) {
    const [bot] = yield* sql<{ bot_id: string }>`
      SELECT bot_id FROM bots WHERE dm_thread_id = ${threadId}
    `.pipe(Effect.mapError(botError("Could not read the bot.")));
    if (bot === undefined) {
      return yield* new BotError({ message: "Only a bot can remember, from its own chat." });
    }
    // The executing turn's original input decides: only a message the user wrote here counts.
    const input = yield* executingTurnOrigin(sql, threadId).pipe(
      Effect.mapError(botError("Could not read the bot.")),
    );
    if (
      input === undefined ||
      input === "unresolved" ||
      input.message_id === null ||
      input.message_id.startsWith("bot-delivery:") ||
      input.scheduled_task_id !== null ||
      input.sender_thread_id !== null
    ) {
      return yield* new BotError({
        message:
          "Only a message the user wrote in this chat can change your memory, not a routine, webhook or another bot.",
      });
    }
    return bot.bot_id;
  });

  const rememberFromThread: BotKnowledgeService["Service"]["rememberFromThread"] = Effect.fn(
    "BotKnowledgeService.rememberFromThread",
  )(function* (input) {
    const botId = yield* dmOwner(input.threadId);
    const memoryId = `m-${(yield* Random.nextIntBetween(0, 2 ** 31)).toString(36)}`;
    yield* writeMemory({
      botId,
      memoryId,
      text: input.text,
      source: "bot",
      sourceThreadId: input.threadId,
    });
    return { memoryId };
  });

  const forgetFromThread: BotKnowledgeService["Service"]["forgetFromThread"] = Effect.fn(
    "BotKnowledgeService.forgetFromThread",
  )(function* (input) {
    const botId = yield* dmOwner(input.threadId);
    const deleted = yield* sql`
      DELETE FROM bot_memories WHERE memory_id = ${input.memoryId} AND bot_id = ${botId}
      RETURNING memory_id
    `.pipe(Effect.mapError(botError("Could not forget.")));
    if (deleted.length === 0) {
      return yield* new BotError({ message: `No memory ${input.memoryId} to forget.` });
    }
    yield* PubSub.publish(changes, botId);
  });

  return BotKnowledgeService.of({
    subscribe,
    saveMemory,
    saveSkill,
    remove,
    rememberFromThread,
    forgetFromThread,
  });
});

export const layer = Layer.effect(BotKnowledgeService, make);
