import { useAtomValue } from "@effect/atom-react";
import { mentionQueryAt, mentionsInText } from "@t3tools/client-runtime/state/bots";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BOT_MESSAGE_MAX_LENGTH,
  type Bot,
  type BotChannelMessage,
  type BotDelivery,
  type BotMention,
  BotMessageId,
  BotRoomId,
  EnvironmentId,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { uuidv4 } from "../../lib/uuid";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useEnvironmentBotRooms, useEnvironmentBots } from "../../state/bots";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotGlyph } from "./BotGlyph";
import { deliveriesByMessage } from "./bot-room";

export type BotRoomParams = {
  readonly environmentId: string;
  readonly roomId: string;
};

const DELIVERY_LABEL = {
  queued: msg("Queued", { $context: "bot delivery status" }),
  accepted: msg("Working", { $context: "bot delivery status" }),
  settled: msg("Replied", { $context: "bot delivery status" }),
  blocked: msg("Blocked", { $context: "bot delivery status" }),
  cancelled: msg("Stopped", { $context: "bot delivery status" }),
} as const;

const DELIVERY_REASON = {
  "Bot deleted": msg("Bot deleted"),
  "Bot archived": msg("Bot archived"),
  "Message missing": msg("Message missing"),
  "Room archived": msg("Room archived"),
  "Removed from the room": msg("Removed from the room"),
  "Chat deleted": msg("Chat deleted"),
  "Needs more access than the sender has": msg("Needs more access than the sender has"),
  "The run failed": msg("The run failed"),
  Stopped: msg("Stopped", { $context: "bot delivery status" }),
  "Could not deliver": msg("Could not deliver"),
} as const;

/** The server sends a fixed set of reasons; anything else shows as sent. */
function deliveryReason(
  reason: string,
  m: (message: (typeof DELIVERY_REASON)[keyof typeof DELIVERY_REASON]) => string,
) {
  return Object.hasOwn(DELIVERY_REASON, reason)
    ? m(DELIVERY_REASON[reason as keyof typeof DELIVERY_REASON])
    : reason;
}

/** A room's shared transcript; @-chips choose who answers, a plain post goes to the default responder. */
export function BotRoomScreen({ route }: StaticScreenProps<BotRoomParams>) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const roomId = BotRoomId.make(route.params.roomId);
  const room =
    useEnvironmentBotRooms().find(
      (entry) => entry.environmentId === environmentId && entry.room.id === roomId,
    )?.room ?? null;
  const botById = new Map(
    useEnvironmentBots()
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => [entry.bot.id as string, entry.bot]),
  );
  const members = room?.memberBotIds.flatMap((botId) => botById.get(botId) ?? []) ?? [];
  const channel = AsyncResult.getOrElse(
    useAtomValue(
      serverEnvironment.botChannelLive({ environmentId, input: { kind: "room", roomId } }),
    ),
    () => null,
  );
  const byMessage = deliveriesByMessage(channel?.deliveries ?? []);
  const seatByBot = new Map(
    room?.participants.map((seat) => [seat.botId as string, seat.threadId]),
  );
  const archived = room?.archivedAt != null;
  const send = useAtomCommand(serverEnvironment.sendBotRoomMessage, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateBotRoom, { reportFailure: false });
  const canPost = useAtomValue(serverEnvironment.sendBotRoomMessage.permissionAtom(environmentId));
  const canEdit = useAtomValue(serverEnvironment.updateBotRoom.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  const scrollRef = useRef<ScrollViewInstance>(null);

  const openSeat = (delivery: BotDelivery) => {
    const threadId = delivery.threadId ?? seatByBot.get(delivery.targetBotId);
    if (threadId === undefined) return;
    // Drill in, so Back returns to the room.
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: String(environmentId),
        threadId: String(threadId),
      }),
    );
  };

  const setArchived = async (next: boolean) => {
    if (room === null || busy) return;
    setBusy(true);
    setError(null);
    const result = await update({ environmentId, input: { roomId: room.id, archived: next } });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not update room"));
    }
  };

  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
      <AppBar
        title={room?.name ?? gt("Room")}
        subtitle={
          room === null
            ? null
            : gt("{members} · default {responder}", {
                members: members.map((bot) => bot.name).join(", "),
                responder: botById.get(room.defaultBotId)?.name ?? "",
              })
        }
        onBack={() => navigation.goBack()}
        actions={
          room === null || !canEdit
            ? []
            : [
                {
                  accessibilityLabel: gt("Edit room"),
                  icon: "square.and.pencil",
                  disabled: busy,
                  onPress: () =>
                    navigation.navigate("BotRoomEditor", {
                      environmentId: String(environmentId),
                      roomId: room.id,
                    }),
                },
                {
                  accessibilityLabel: archived ? gt("Restore room") : gt("Archive room"),
                  icon: archived ? "tray.and.arrow.up" : "tray.and.arrow.down",
                  disabled: busy,
                  onPress: () => void setArchived(!archived),
                },
              ]
        }
      />
      <ScrollViewMarker style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={{ padding: 20, paddingBottom: composerHeight + bottomInset + 24 }}
        >
          {channel !== null && channel.messages.length === 0 ? (
            <Text className="py-10 text-center text-sm text-foreground-muted">
              {gt("Mention bots with @ to choose who answers.")}
            </Text>
          ) : null}
          {(channel?.messages ?? []).map((message) => (
            <RoomMessage
              key={message.id}
              message={message}
              sender={message.sender.kind === "bot" ? botById.get(message.sender.botId) : undefined}
              deliveries={byMessage.get(message.id) ?? []}
              botName={(botId) => botById.get(botId)?.name ?? gt("Bot")}
              onOpenSeat={openSeat}
            />
          ))}
          {error ? (
            <Text selectable className="py-4 text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </ScrollViewMarker>
      <View className="absolute inset-x-4 bottom-0" style={{ paddingBottom: bottomInset }}>
        {archived ? (
          <Text className="pb-2 text-center text-xs text-foreground-muted">
            {gt("This room is archived. Restore it to post again.")}
          </Text>
        ) : (
          <RoomComposer
            bots={members}
            placeholder={gt("Message {room}", { room: room?.name ?? "" })}
            disabled={room === null || !canPost}
            onLayoutHeight={setComposerHeight}
            onSend={async (text, mentions, messageId) => {
              if (room === null) return false;
              setError(null);
              const result = await send({
                environmentId,
                input: { roomId: room.id, messageId: BotMessageId.make(messageId), text, mentions },
              });
              if (AsyncResult.isFailure(result)) {
                const cause = squashAtomCommandFailure(result);
                setError(cause instanceof Error ? cause.message : gt("Could not send"));
                return false;
              }
              return true;
            }}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function RoomMessage(props: {
  readonly message: BotChannelMessage;
  readonly sender: Bot | undefined;
  readonly deliveries: ReadonlyArray<BotDelivery>;
  readonly botName: (botId: string) => string;
  readonly onOpenSeat: (delivery: BotDelivery) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { message } = props;
  return (
    <View className="gap-1.5 border-b border-border-subtle py-4">
      <View className="flex-row items-center gap-2">
        {props.sender ? (
          <BotGlyph glyph={props.sender.avatar} size={16} colorClassName="accent-icon-muted" />
        ) : null}
        <Text className="font-t3-medium text-sm text-foreground">
          {message.sender.kind === "bot" ? (props.sender?.name ?? gt("Bot")) : gt("You")}
        </Text>
      </View>
      <Text selectable className="text-base leading-normal text-foreground">
        {message.text}
      </Text>
      {props.deliveries.map((delivery) => (
        <Pressable
          key={delivery.id}
          accessibilityRole="button"
          className="flex-row items-center gap-1.5 active:opacity-60"
          onPress={() => props.onOpenSeat(delivery)}
        >
          {delivery.status === "accepted" || delivery.status === "queued" ? (
            <View className="size-1.5 rounded-full bg-foreground-muted/60" />
          ) : null}
          <Text className="text-xs text-foreground-muted">
            {`${props.botName(delivery.targetBotId)} · ${m(DELIVERY_LABEL[delivery.status])}${
              delivery.reason ? ` · ${deliveryReason(delivery.reason, m)}` : ""
            }`}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Only an @-pick makes a chip; a typed `@Name` without one routes nowhere. */
function RoomComposer(props: {
  readonly bots: ReadonlyArray<Bot>;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onLayoutHeight: (height: number) => void;
  /** `messageId` is kept across retries of one submission, so a resend posts once. */
  readonly onSend: (
    text: string,
    mentions: ReadonlyArray<BotMention>,
    messageId: string,
  ) => Promise<boolean>;
}) {
  const gt = useGT();
  const [text, setText] = useState("");
  const [chips, setChips] = useState<ReadonlyArray<BotMention>>([]);
  const [caret, setCaret] = useState(0);
  // Set only to move the caret after a pick; the input owns it otherwise.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
  const [sending, setSending] = useState(false);
  const submissionId = useRef<string | null>(null);
  const query = mentionQueryAt(text, caret);
  const suggestions =
    query === null
      ? []
      : props.bots
          .filter((bot) => bot.name.toLowerCase().startsWith(query.query.toLowerCase()))
          .slice(0, 5);
  const mentions = mentionsInText(text, chips);

  const pick = (bot: Bot) => {
    if (query === null) return;
    const inserted = `@${bot.name} `;
    // A pick changes who is addressed, so it is a new submission.
    submissionId.current = null;
    setText(`${text.slice(0, query.start)}${inserted}${text.slice(caret)}`);
    setChips([...chips, { botId: bot.id, label: bot.name }]);
    const next = query.start + inserted.length;
    setCaret(next);
    setSelection({ start: next, end: next });
  };

  const send = async () => {
    if (sending || text.trim() === "") return;
    setSending(true);
    const messageId = submissionId.current ?? uuidv4();
    submissionId.current = messageId;
    const sent = await props.onSend(text.trim(), mentions, messageId);
    if (sent) submissionId.current = null;
    setSending(false);
    if (sent) {
      setText("");
      setChips([]);
      setCaret(0);
    }
  };

  return (
    <View
      className="gap-2"
      onLayout={(event) => props.onLayoutHeight(event.nativeEvent.layout.height)}
    >
      {suggestions.length > 0 ? (
        <GlassSurface chrome="none" className="p-1">
          {suggestions.map((bot) => (
            <Pressable
              key={bot.id}
              accessibilityRole="button"
              accessibilityLabel={gt("Mention {name}", { name: bot.name })}
              className="flex-row items-center gap-2 rounded-xl px-3 py-2.5 active:bg-subtle"
              onPress={() => pick(bot)}
            >
              <BotGlyph glyph={bot.avatar} size={18} colorClassName="accent-icon-muted" />
              <Text className="font-t3-medium text-base text-foreground">{bot.name}</Text>
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {bot.title}
              </Text>
            </Pressable>
          ))}
        </GlassSurface>
      ) : null}
      <GlassSurface chrome="none" className="gap-1 p-1">
        {mentions.length > 0 ? (
          <View
            accessibilityLabel={gt("Addressed to")}
            className="flex-row flex-wrap gap-1 px-3 pt-2"
          >
            {mentions.map((mention) => (
              <View key={mention.botId} className="rounded-md border border-border px-1.5 py-0.5">
                <Text className="font-t3-medium text-xs text-foreground">@{mention.label}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View className="flex-row items-end gap-1">
          <TextInput
            multiline
            accessibilityLabel={props.placeholder}
            placeholder={props.placeholder}
            placeholderTextColorClassName="accent-foreground-muted"
            maxLength={BOT_MESSAGE_MAX_LENGTH}
            editable={!props.disabled && !sending}
            value={text}
            {...(selection === undefined ? {} : { selection })}
            onChangeText={(next) => {
              // An edited draft is a new submission.
              submissionId.current = null;
              setText(next);
            }}
            onSelectionChange={(event) => {
              setCaret(event.nativeEvent.selection.end);
              setSelection(undefined);
            }}
            className="max-h-36 min-h-12 min-w-0 flex-1 rounded-[24px] border-0 bg-transparent px-4 py-3 text-base text-foreground"
          />
          <View>
            <Button
              label={gt("Send")}
              tone="contrast"
              disabled={props.disabled || sending || text.trim() === ""}
              onPress={() => void send()}
            />
          </View>
        </View>
      </GlassSurface>
    </View>
  );
}
