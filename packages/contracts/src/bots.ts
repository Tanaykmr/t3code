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

export const BotRoomId = TrimmedNonEmptyString.pipe(Schema.brand("BotRoomId"));
export type BotRoomId = typeof BotRoomId.Type;
export const BotMessageId = TrimmedNonEmptyString.pipe(Schema.brand("BotMessageId"));
export type BotMessageId = typeof BotMessageId.Type;

export const BOT_ROOM_MAX_MEMBERS = 8;
export const BOT_MESSAGE_MAX_LENGTH = 20_000;

/** A composer chip: routing uses the id, the label keeps the name the sender saw. */
export const BotMention = Schema.Struct({ botId: BotId, label: TrimmedNonEmptyString });
export type BotMention = typeof BotMention.Type;

export const BotRoom = Schema.Struct({
  id: BotRoomId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH * 2)),
  memberBotIds: Schema.Array(BotId),
  defaultBotId: BotId,
  /** Each member answers from its own thread, keyed by room and bot. */
  participants: Schema.Array(Schema.Struct({ botId: BotId, threadId: ThreadId })),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type BotRoom = typeof BotRoom.Type;

export const BotDirectory = Schema.Struct({
  bots: Schema.Array(Bot),
  rooms: Schema.Array(BotRoom),
});
export type BotDirectory = typeof BotDirectory.Type;

export const BotMessageSender = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
]);
export type BotMessageSender = typeof BotMessageSender.Type;

/**
 * One message in a room, a peer exchange between two bots, or a handoff out of a
 * bot's DM. `channelKey` is `room:<roomId>`, `peer:<botId>:<botId>` or `dm:<botId>`.
 */
export const BotChannelMessage = Schema.Struct({
  id: BotMessageId,
  seq: Schema.Int,
  channelKey: TrimmedNonEmptyString,
  sender: BotMessageSender,
  text: Schema.String,
  mentions: Schema.Array(BotMention),
  replyToId: Schema.NullOr(BotMessageId),
  originThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BotChannelMessage = typeof BotChannelMessage.Type;

export const BotDeliveryStatus = Schema.Literals([
  "queued",
  "accepted",
  "settled",
  "blocked",
  "cancelled",
]);
export type BotDeliveryStatus = typeof BotDeliveryStatus.Type;

/** One wake of one bot for one message; a message never wakes the same bot twice. */
export const BotDelivery = Schema.Struct({
  id: TrimmedNonEmptyString,
  messageId: BotMessageId,
  targetBotId: BotId,
  status: BotDeliveryStatus,
  threadId: Schema.NullOr(ThreadId),
  reason: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type BotDelivery = typeof BotDelivery.Type;

export const BotChannelQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("room"), roomId: BotRoomId }),
  /** The bot's peer exchanges and the handoffs out of its DM. */
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
]);
export type BotChannelQuery = typeof BotChannelQuery.Type;

export const BotChannelSnapshot = Schema.Struct({
  messages: Schema.Array(BotChannelMessage),
  deliveries: Schema.Array(BotDelivery),
});
export type BotChannelSnapshot = typeof BotChannelSnapshot.Type;

const RoomMembers = Schema.Array(BotId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BOT_ROOM_MAX_MEMBERS),
);
const RoomName = TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_NAME_MAX_LENGTH * 2));

export const BotRoomCreateInput = Schema.Struct({
  roomId: BotRoomId,
  name: RoomName,
  memberBotIds: RoomMembers,
  defaultBotId: BotId,
});
export type BotRoomCreateInput = typeof BotRoomCreateInput.Type;

export const BotRoomUpdateInput = Schema.Struct({
  roomId: BotRoomId,
  name: Schema.optional(RoomName),
  memberBotIds: Schema.optional(RoomMembers),
  defaultBotId: Schema.optional(BotId),
  archived: Schema.optional(Schema.Boolean),
});
export type BotRoomUpdateInput = typeof BotRoomUpdateInput.Type;

export const BotRoomMutationResult = Schema.Struct({ room: BotRoom });
export type BotRoomMutationResult = typeof BotRoomMutationResult.Type;

const MessageText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BOT_MESSAGE_MAX_LENGTH),
);

export const BotRoomSendInput = Schema.Struct({
  roomId: BotRoomId,
  /** Chosen by the client: a resend with the same id wakes nobody twice. */
  messageId: BotMessageId,
  text: MessageText,
  mentions: Schema.Array(BotMention),
});
export type BotRoomSendInput = typeof BotRoomSendInput.Type;

/** An @-chip in a bot's DM: each addressed bot gets the text with a link back to the DM. */
export const BotHandoffInput = Schema.Struct({
  botId: BotId,
  messageId: BotMessageId,
  text: MessageText,
  mentions: Schema.Array(BotMention).check(Schema.isMinLength(1)),
});
export type BotHandoffInput = typeof BotHandoffInput.Type;

export const BotSendResult = Schema.Struct({ message: BotChannelMessage });
export type BotSendResult = typeof BotSendResult.Type;
