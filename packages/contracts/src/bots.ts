import * as Schema from "effect/Schema";

import {
  BotId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** Line glyphs every client can draw; each client maps a key to its own icon set. */
export const BOT_AVATARS = [
  "bot",
  "lightbulb",
  "code",
  "compass",
  "flask",
  "feather",
  "rocket",
  "shield",
] as const;
export const BotAvatar = Schema.Literals(BOT_AVATARS);
export type BotAvatar = typeof BotAvatar.Type;

export const BOT_NAME_MAX_LENGTH = 40;
export const BOT_TITLE_MAX_LENGTH = 80;
export const BOT_PERSONA_MAX_LENGTH = 8_000;

const BotName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOT_NAME_MAX_LENGTH),
  // Mentions route by id, but a name with spaces or "@" would read as two chips.
  Schema.isPattern(/^[\p{L}\p{N}_.-]+$/u),
);
const BotTitle = TrimmedString.check(Schema.isMaxLength(BOT_TITLE_MAX_LENGTH));
const BotPersona = Schema.String.check(Schema.isMaxLength(BOT_PERSONA_MAX_LENGTH));

/**
 * A named agent whose private DM is an ordinary thread. Model and runtime policy
 * come from that thread; unread state is the thread's visit watermark.
 */
export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  title: BotTitle,
  avatar: BotAvatar,
  persona: BotPersona,
  personaRevision: PositiveInt,
  dmThreadId: ThreadId,
  projectId: ProjectId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Bot = typeof Bot.Type;

export const BotDirectory = Schema.Struct({
  bots: Schema.Array(Bot),
});
export type BotDirectory = typeof BotDirectory.Type;

export const BotCreateInput = Schema.Struct({
  /** Chosen by the client so a retried create reuses the same bot and DM. */
  botId: BotId,
  name: BotName,
  title: BotTitle,
  avatar: BotAvatar,
  persona: BotPersona,
  projectId: ProjectId,
  modelSelection: ModelSelection,
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(BotName),
  title: Schema.optional(BotTitle),
  avatar: Schema.optional(BotAvatar),
  persona: Schema.optional(BotPersona),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotRefInput = Schema.Struct({ botId: BotId });
export type BotRefInput = typeof BotRefInput.Type;

export const BotMutationResult = Schema.Struct({ bot: Bot });
export type BotMutationResult = typeof BotMutationResult.Type;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  message: Schema.String,
  botId: Schema.optional(BotId),
  cause: Schema.optional(Schema.Defect()),
}) {}
