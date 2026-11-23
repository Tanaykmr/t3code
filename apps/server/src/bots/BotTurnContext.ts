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
    const forThread = Effect.fn("BotTurnContext.forThread")(function* (threadId: ThreadId) {
      // A bot's DM or its seat in a room.
      const rows = yield* sql<{ name: string; title: string; persona: string }>`
        SELECT name, title, persona FROM bots WHERE dm_thread_id = ${threadId}
        UNION ALL
        SELECT bots.name, bots.title, bots.persona FROM bot_room_threads
        JOIN bots ON bots.bot_id = bot_room_threads.bot_id
        WHERE bot_room_threads.thread_id = ${threadId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read bot persona.", { cause }).pipe(Effect.as([])),
        ),
      );
      const bot = rows[0];
      return bot === undefined ? [] : [{ key: "t3_bot_persona", text: personaText(bot) }];
    });
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
