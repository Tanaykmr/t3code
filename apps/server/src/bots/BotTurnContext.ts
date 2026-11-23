import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureBotSchema } from "./botStore.ts";

export interface BotTurnContextEntry {
  readonly key: string;
  readonly text: string;
}

/** The persona a bot's DM sends with each provider turn; other threads get none. */
export class BotTurnContext extends Context.Service<
  BotTurnContext,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<BotTurnContextEntry>>;
  }
>()("t3/bots/BotTurnContext") {}

const MEMORY_ENTRIES = 20;
const CONTEXT_MAX_CHARS = 4_000;

const boundedText = (text: string) =>
  text.length <= CONTEXT_MAX_CHARS ? text : `${text.slice(0, CONTEXT_MAX_CHARS)}…`;

function skillsText(
  skills: ReadonlyArray<{ readonly name: string; readonly instructions: string }>,
) {
  if (skills.length === 0)
    return "No skills are enabled for you now. Ignore any you were given before.";
  return [
    "Skills the user enabled for you. Follow one when the request matches it:",
    ...skills.map((skill) => `## ${skill.name}\n${skill.instructions}`),
  ].join("\n\n");
}

function memoryText(
  memories: ReadonlyArray<{ readonly memory_id: string; readonly text: string }>,
) {
  if (memories.length === 0)
    return "You remember nothing about the user now. Disregard earlier memories.";
  return [
    "What you remember about the user, newest first. Forget an entry by its id when the user asks.",
    ...memories.map((memory) => `- [${memory.memory_id}] ${memory.text}`),
  ].join("\n");
}

function personaText(bot: {
  readonly name: string;
  readonly title: string;
  readonly persona: string;
}): string {
  const role = bot.title === "" ? "" : `, ${bot.title}`;
  const persona = bot.persona.trim();
  return [
    `You are ${bot.name}${role}: a named bot the user chats with in T3 Code. This thread is your private chat with the user. Answer as ${bot.name}.`,
    ...(persona === "" ? [] : [`Your persona, written by the user:\n${persona}`]),
  ].join("\n\n");
}

export const layer = Layer.effect(
  BotTurnContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureBotSchema;
    const forThread = Effect.fn("BotTurnContext.forThread")(
      function* (threadId: ThreadId) {
        // A bot's DM or its seat in a room; only the DM sees the bot's private memory.
        const rows = yield* sql<{
          bot_id: string;
          name: string;
          title: string;
          persona: string;
          is_dm: number;
        }>`
        SELECT bot_id, name, title, persona, 1 AS is_dm FROM bots WHERE dm_thread_id = ${threadId}
        UNION ALL
        SELECT bots.bot_id, bots.name, bots.title, bots.persona, 0 AS is_dm FROM bot_room_threads
        JOIN bots ON bots.bot_id = bot_room_threads.bot_id
        WHERE bot_room_threads.thread_id = ${threadId}
      `;
        const bot = rows[0];
        if (bot === undefined) return [];
        const skills = yield* sql<{ name: string; instructions: string }>`
        SELECT name, instructions FROM bot_skills
        WHERE bot_id = ${bot.bot_id} AND enabled = 1 ORDER BY created_at
      `;
        const memories =
          bot.is_dm === 1
            ? yield* sql<{ memory_id: string; text: string }>`
              SELECT memory_id, text FROM bot_memories WHERE bot_id = ${bot.bot_id}
              ORDER BY updated_at DESC LIMIT ${MEMORY_ENTRIES}
            `
            : [];
        // Both entries are always sent, so a forgotten memory or disabled skill replaces
        // what the provider saw earlier instead of silently lingering in its history.
        return [
          { key: "t3_bot_persona", text: personaText(bot) },
          { key: "t3_bot_skills", text: boundedText(skillsText(skills)) },
          ...(bot.is_dm === 1
            ? [{ key: "t3_bot_memory", text: boundedText(memoryText(memories)) }]
            : []),
        ];
      },
      (effect) =>
        effect.pipe(
          NodeSqliteClient.readOnly,
          Effect.catch((cause) =>
            Effect.logWarning("Failed to read bot persona.", { cause }).pipe(
              Effect.as([] as ReadonlyArray<BotTurnContextEntry>),
            ),
          ),
        ),
    );
    return BotTurnContext.of({ forThread });
  }),
);

/** Read once while building a layer; tests and tools without bots send no persona. */
export const optional = Effect.serviceOption(BotTurnContext);

export const forProvider = (
  service: Option.Option<BotTurnContext["Service"]>,
  threadId: ThreadId,
): Effect.Effect<ReadonlyArray<BotTurnContextEntry>> =>
  Option.isSome(service) ? service.value.forThread(threadId) : Effect.succeed([]);
