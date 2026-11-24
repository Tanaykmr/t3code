import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureBotSchema, executingTurnOrigin, isOperatorOrigin } from "./botStore.ts";

export interface BotTurnContextEntry {
  readonly key: string;
  readonly text: string;
}

/** The persona a bot's DM sends with each provider turn; other threads get none. */
export class BotTurnContext extends Context.Service<
  BotTurnContext,
  {
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<BotTurnContextEntry>>;
    /** Projects a bot-owned thread may start coding work in; null for an ordinary thread. */
    readonly workTargets: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<string> | null>;
    /** DM, peer, and room seat threads. Null means ownership could not be checked. */
    readonly privateThreadIds: Effect.Effect<ReadonlySet<ThreadId> | null>;
    /** Whether the thread is a bot's private chat, not a room or peer seat. */
    readonly isDm: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Whether the executing turn answers the user directly, not a bot, routine or webhook. */
    readonly isOperatorTurn: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/bots/BotTurnContext") {}

const MEMORY_ENTRIES = 20;
const SKILL_ENTRIES = 20;
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

const decodeProjectIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function workTargetsText(
  targets: ReadonlyArray<{ readonly projectId: string; readonly title: string }>,
) {
  return [
    'Projects the user lets you start coding work in. To work in one other than your own, call delegate_task with target.projectId and isolation "worktree":',
    ...targets.map((target) => `- ${target.title}: ${target.projectId}`),
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
    // The home project first, then the projects the user allowed that still exist.
    const targetsOf = Effect.fn("BotTurnContext.targetsOf")(function* (bot: {
      readonly project_id: string;
      readonly allowed_project_ids_json: string;
    }) {
      const allowed = yield* decodeProjectIds(bot.allowed_project_ids_json).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );
      const ids = [bot.project_id, ...allowed.filter((id) => id !== bot.project_id)];
      const rows = yield* sql<{ project_id: string; title: string }>`
        SELECT project_id, title FROM projection_projects
        WHERE ${sql.in("project_id", ids)} AND deleted_at IS NULL
      `;
      return ids.flatMap((projectId) => {
        const row = rows.find((candidate) => candidate.project_id === projectId);
        return row === undefined ? [] : [{ projectId, title: row.title }];
      });
    });
    const forThread = Effect.fn("BotTurnContext.forThread")(
      function* (threadId: ThreadId) {
        // A bot's DM or its seat in a room; only the DM sees the bot's private memory.
        const rows = yield* sql<{
          bot_id: string;
          name: string;
          title: string;
          persona: string;
          project_id: string;
          allowed_project_ids_json: string;
          is_dm: number;
        }>`
        SELECT bot_id, name, title, persona, project_id, allowed_project_ids_json, 1 AS is_dm
        FROM bots WHERE dm_thread_id = ${threadId}
        UNION ALL
        SELECT bot_id, name, title, persona, project_id, allowed_project_ids_json, 0 AS is_dm
        FROM bots WHERE peer_thread_id = ${threadId}
        UNION ALL
        SELECT bots.bot_id, bots.name, bots.title, bots.persona, bots.project_id,
          bots.allowed_project_ids_json, 0 AS is_dm FROM bot_room_threads
        JOIN bots ON bots.bot_id = bot_room_threads.bot_id
        WHERE bot_room_threads.thread_id = ${threadId}
      `;
        const bot = rows[0];
        if (bot === undefined) return [];
        const skills = yield* sql<{ name: string; instructions: string }>`
        SELECT name, instructions FROM bot_skills
        WHERE bot_id = ${bot.bot_id} AND enabled = 1 ORDER BY created_at LIMIT ${SKILL_ENTRIES}
      `;
        // A turn another bot woke, or a continuation of one, sees no private memory; nor does
        // a turn whose origin cannot be read.
        const origin = yield* executingTurnOrigin(sql, threadId).pipe(
          Effect.orElseSucceed(() => "unresolved" as const),
        );
        const deliveryId =
          origin !== undefined &&
          origin !== "unresolved" &&
          origin.message_id?.startsWith("bot-delivery:") === true
            ? origin.message_id.slice("bot-delivery:".length)
            : null;
        const woken =
          deliveryId === null
            ? []
            : yield* sql<{ sender_bot_id: string | null }>`
              SELECT message.sender_bot_id FROM bot_deliveries AS delivery
              JOIN bot_messages AS message ON message.message_id = delivery.message_id
              WHERE delivery.delivery_id = ${deliveryId}
            `.pipe(Effect.orElseSucceed(() => null));
        const peerTurn =
          origin === "unresolved" ||
          woken === null ||
          (deliveryId !== null && woken[0] === undefined) ||
          woken[0]?.sender_bot_id != null;
        const memories =
          bot.is_dm === 1
            ? yield* sql<{ memory_id: string; text: string }>`
              SELECT memory_id, text FROM bot_memories WHERE bot_id = ${bot.bot_id}
              ORDER BY updated_at DESC LIMIT ${MEMORY_ENTRIES}
            `
            : [];
        const targets = yield* targetsOf(bot).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<{ projectId: string; title: string }>),
        );
        // Both entries are always sent, so a forgotten memory or disabled skill replaces
        // what the provider saw earlier instead of silently lingering in its history.
        return [
          { key: "t3_bot_persona", text: personaText(bot) },
          ...(targets.length <= 1
            ? []
            : [{ key: "t3_bot_work_targets", text: workTargetsText(targets) }]),
          { key: "t3_bot_skills", text: boundedText(skillsText(skills)) },
          ...(bot.is_dm === 1
            ? [
                {
                  key: "t3_bot_memory",
                  text: peerTurn
                    ? "Another bot woke this turn. Your memory of the user stays private; do not share it."
                    : boundedText(memoryText(memories)),
                },
              ]
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
    const workTargets = Effect.fn("BotTurnContext.workTargets")(
      function* (threadId: ThreadId) {
        const [bot] = yield* sql<{ project_id: string; allowed_project_ids_json: string }>`
          SELECT project_id, allowed_project_ids_json FROM bots
          WHERE dm_thread_id = ${threadId} OR peer_thread_id = ${threadId}
          UNION ALL
          SELECT bots.project_id, bots.allowed_project_ids_json FROM bot_room_threads
          JOIN bots ON bots.bot_id = bot_room_threads.bot_id
          WHERE bot_room_threads.thread_id = ${threadId}
        `;
        if (bot === undefined) return null;
        return (yield* targetsOf(bot)).map((target) => target.projectId);
      },
      (effect) => effect.pipe(Effect.orElseSucceed(() => null)),
    );
    const isDm = Effect.fn("BotTurnContext.isDm")(
      function* (threadId: ThreadId) {
        const rows = yield* sql`SELECT 1 FROM bots WHERE dm_thread_id = ${threadId}`;
        return rows.length > 0;
      },
      (effect) => effect.pipe(Effect.orElseSucceed(() => false)),
    );
    const isOperatorTurn = Effect.fn("BotTurnContext.isOperatorTurn")(
      function* (threadId: ThreadId) {
        return isOperatorOrigin(yield* executingTurnOrigin(sql, threadId));
      },
      (effect) => effect.pipe(Effect.orElseSucceed(() => false)),
    );
    const privateThreadIds = sql<{ thread_id: string }>`
      SELECT dm_thread_id AS thread_id FROM bots WHERE dm_thread_id IS NOT NULL
      UNION ALL SELECT peer_thread_id FROM bots WHERE peer_thread_id IS NOT NULL
      UNION ALL SELECT thread_id FROM bot_room_threads
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => new Set(rows.map(({ thread_id }) => ThreadId.make(thread_id)))),
      Effect.orElseSucceed(() => null),
    );
    return BotTurnContext.of({ forThread, workTargets, privateThreadIds, isDm, isOperatorTurn });
  }),
);

/** Read once while building a layer; tests and tools without bots send no persona. */
export const optional = Effect.serviceOption(BotTurnContext);

export const forProvider = (
  service: Option.Option<BotTurnContext["Service"]>,
  threadId: ThreadId,
): Effect.Effect<ReadonlyArray<BotTurnContextEntry>> =>
  Option.isSome(service) ? service.value.forThread(threadId) : Effect.succeed([]);
