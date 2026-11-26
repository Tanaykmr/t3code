import { BotId, BotMessageId, BotRoomId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deliveriesByMessage, newestMessages, partitionRooms } from "./bot-room";

const room = (id: string, name: string, archivedAt: string | null = null) => ({
  environmentId: EnvironmentId.make("env"),
  room: {
    id: BotRoomId.make(id),
    name,
    memberBotIds: [BotId.make("ada")],
    defaultBotId: BotId.make("ada"),
    participants: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
  },
});

const message = (id: string) => ({
  id: BotMessageId.make(id),
  seq: Number(id.slice(1)),
  channelKey: "room:r",
  sender: { kind: "user" as const },
  text: id,
  mentions: [],
  replyToId: null,
  originThreadId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("bot rooms", () => {
  it("searches rooms and lists archived ones last", () => {
    const rooms = [room("a", "Old", "2026-01-02"), room("b", "Release room"), room("c", "Ops")];
    expect(partitionRooms(rooms).map((entry) => entry.room.name)).toEqual([
      "Release room",
      "Ops",
      "Old",
    ]);
    expect(partitionRooms(rooms, "rel").map((entry) => entry.room.name)).toEqual(["Release room"]);
  });

  it("groups deliveries by message and shows the newest messages first", () => {
    const delivery = (id: string, messageId: string) => ({
      id,
      messageId: BotMessageId.make(messageId),
      targetBotId: BotId.make("ada"),
      status: "queued" as const,
      threadId: null,
      reason: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const grouped = deliveriesByMessage([
      delivery("1", "m1"),
      delivery("2", "m1"),
      delivery("3", "m2"),
    ]);
    expect(grouped.get("m1")?.map((d) => d.id)).toEqual(["1", "2"]);
    expect(
      newestMessages([message("m1"), message("m2"), message("m3")], 2).map((m) => m.id),
    ).toEqual(["m3", "m2"]);
  });
});
