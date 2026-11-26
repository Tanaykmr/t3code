import type { EnvironmentBotRoom } from "@t3tools/client-runtime/state/bots";
import type { BotChannelMessage, BotDelivery } from "@t3tools/contracts";

/** Rooms matching the search, active first, archived after. */
export function partitionRooms(rooms: ReadonlyArray<EnvironmentBotRoom>, query = "") {
  const needle = query.trim().toLowerCase();
  const matching =
    needle === "" ? rooms : rooms.filter(({ room }) => room.name.toLowerCase().includes(needle));
  return [
    ...matching.filter((entry) => entry.room.archivedAt === null),
    ...matching.filter((entry) => entry.room.archivedAt !== null),
  ];
}

/** Each message's deliveries, in the order the server recorded them. */
export function deliveriesByMessage(
  deliveries: ReadonlyArray<BotDelivery>,
): ReadonlyMap<string, ReadonlyArray<BotDelivery>> {
  const byMessage = new Map<string, Array<BotDelivery>>();
  for (const delivery of deliveries) {
    const list = byMessage.get(delivery.messageId) ?? [];
    list.push(delivery);
    byMessage.set(delivery.messageId, list);
  }
  return byMessage;
}

/** The newest messages first, at most `limit`. */
export function newestMessages(
  messages: ReadonlyArray<BotChannelMessage>,
  limit: number,
): ReadonlyArray<BotChannelMessage> {
  return messages.slice(-limit).reverse();
}
