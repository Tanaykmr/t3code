import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BotChannelMessage,
  type BotDelivery,
  BotMessageId,
  type BotRoomId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ArchiveIcon, ArchiveRestoreIcon, MessagesSquareIcon, PencilIcon } from "lucide-react";
import { T, useGT, useMessages, msg } from "gt-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentBotRooms, useEnvironmentBots } from "../../state/bots";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { BotMentionComposer } from "./BotMentionComposer";
import { openBotRoomEditor } from "./BotRoomDialog";

const DELIVERY_LABEL = {
  queued: msg("Queued", { $context: "bot delivery status" }),
  accepted: msg("Working", { $context: "bot delivery status" }),
  settled: msg("Replied", { $context: "bot delivery status" }),
  blocked: msg("Blocked", { $context: "bot delivery status" }),
  cancelled: msg("Stopped", { $context: "bot delivery status" }),
} as const;

export function BotRoomView(props: {
  readonly environmentId: EnvironmentId;
  readonly roomId: BotRoomId;
}) {
  const gt = useGT();
  const entry = useEnvironmentBotRooms().find(
    (candidate) =>
      candidate.environmentId === props.environmentId && candidate.room.id === props.roomId,
  );
  const bots = useEnvironmentBots().filter((bot) => bot.environmentId === props.environmentId);
  const channel = AsyncResult.getOrElse(
    useAtomValue(
      serverEnvironment.botChannelLive({
        environmentId: props.environmentId,
        input: { kind: "room", roomId: props.roomId },
      }),
    ),
    () => null,
  );
  const send = useAtomCommand(serverEnvironment.sendBotRoomMessage, { label: "bot room send" });
  const update = useAtomCommand(serverEnvironment.updateBotRoom, { label: "bot room update" });
  const [busy, setBusy] = useState(false);
  const room = entry?.room ?? null;
  const botById = new Map(bots.map(({ bot }) => [bot.id, bot]));
  const members = room?.memberBotIds.flatMap((botId) => botById.get(botId) ?? []) ?? [];
  const seatByBot = new Map(room?.participants.map((seat) => [seat.botId, seat.threadId]) ?? []);
  const deliveriesByMessage = new Map<string, Array<BotDelivery>>();
  for (const delivery of channel?.deliveries ?? []) {
    const list = deliveriesByMessage.get(delivery.messageId) ?? [];
    list.push(delivery);
    deliveriesByMessage.set(delivery.messageId, list);
  }
  const archived = room?.archivedAt != null;

  const setArchived = async (next: boolean) => {
    if (room === null) return;
    setBusy(true);
    const result = await update({
      environmentId: props.environmentId,
      input: { roomId: room.id, archived: next },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not update room"),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="gap-3 border-b border-border">
          <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-sm font-medium">{room?.name ?? gt("Room")}</h1>
            {room === null ? null : (
              <p className="truncate text-xs text-muted-foreground">
                {gt("{members} · default {responder}", {
                  members: members.map((bot) => bot.name).join(", "),
                  responder: botById.get(room.defaultBotId)?.name ?? "",
                })}
              </p>
            )}
          </div>
          {room === null ? null : (
            <>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={gt("Edit room")}
                onClick={() =>
                  openBotRoomEditor({ mode: "edit", environmentId: props.environmentId, room })
                }
              >
                <PencilIcon aria-hidden />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={busy}
                aria-label={archived ? gt("Restore room") : gt("Archive room")}
                onClick={() => void setArchived(!archived)}
              >
                {archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
              </Button>
            </>
          )}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <ol className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-5 py-6">
            {(channel?.messages ?? []).map((message) => (
              <RoomMessage
                key={message.id}
                environmentId={props.environmentId}
                message={message}
                senderName={
                  message.sender.kind === "bot"
                    ? (botById.get(message.sender.botId)?.name ?? gt("Bot"))
                    : gt("You")
                }
                senderBot={
                  message.sender.kind === "bot" ? botById.get(message.sender.botId) : undefined
                }
                deliveries={deliveriesByMessage.get(message.id) ?? []}
                botName={(botId) => botById.get(botId)?.name ?? gt("Bot")}
                seatThread={(botId) => seatByBot.get(botId)}
              />
            ))}
            {channel !== null && channel.messages.length === 0 ? (
              <li className="py-12 text-center text-sm text-muted-foreground">
                <T>Mention bots with @ to choose who answers.</T>
              </li>
            ) : null}
          </ol>
        </ScrollArea>
        <div className="mx-auto w-full max-w-3xl px-5 pb-5">
          {archived ? (
            <p className="mb-2 text-xs text-muted-foreground">
              <T>This room is archived. Restore it to post again.</T>
            </p>
          ) : null}
          <BotMentionComposer
            bots={members}
            disabled={room === null || archived}
            placeholder={gt("Message {room}", { room: room?.name ?? "" })}
            onSend={async ({ text, mentions }) => {
              if (room === null) return false;
              const result = await send({
                environmentId: props.environmentId,
                input: {
                  roomId: room.id,
                  messageId: BotMessageId.make(randomUUID()),
                  text,
                  mentions,
                },
              });
              if (result._tag === "Failure") {
                if (!isAtomCommandInterrupted(result)) {
                  toastManager.add({
                    type: "error",
                    title: gt("Could not send"),
                    description: String(squashAtomCommandFailure(result)),
                  });
                }
                return false;
              }
              return true;
            }}
          />
        </div>
      </div>
    </SidebarInset>
  );
}

function RoomMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: BotChannelMessage;
  readonly senderName: string;
  readonly senderBot:
    | { readonly avatar: Parameters<typeof BotAvatarIcon>[0]["avatar"] }
    | undefined;
  readonly deliveries: ReadonlyArray<BotDelivery>;
  readonly botName: (botId: BotDelivery["targetBotId"]) => string;
  readonly seatThread: (botId: BotDelivery["targetBotId"]) => ThreadId | undefined;
}) {
  const m = useMessages();
  const { message } = props;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        {props.senderBot ? (
          <BotAvatarIcon
            avatar={props.senderBot.avatar}
            className="size-3.5 text-muted-foreground"
          />
        ) : null}
        <span className="font-medium text-foreground">{props.senderName}</span>
      </div>
      {message.sender.kind === "bot" ? (
        <ChatMarkdown text={message.text} cwd={undefined} environmentId={props.environmentId} />
      ) : (
        <p className="text-sm whitespace-pre-wrap">{message.text}</p>
      )}
      {props.deliveries.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {props.deliveries.map((delivery) => {
            const threadId = delivery.threadId ?? props.seatThread(delivery.targetBotId);
            const label = `${props.botName(delivery.targetBotId)} · ${m(DELIVERY_LABEL[delivery.status])}${
              delivery.reason ? ` · ${delivery.reason}` : ""
            }`;
            return (
              <li key={delivery.id} className="flex items-center gap-1">
                {delivery.status === "accepted" || delivery.status === "queued" ? (
                  <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/60" />
                ) : null}
                {threadId ? (
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId))}
                    className="hover:text-foreground hover:underline"
                  >
                    {label}
                  </Link>
                ) : (
                  <span>{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
