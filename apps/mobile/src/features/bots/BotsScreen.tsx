import type { EnvironmentBot } from "@t3tools/client-runtime/state/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useBotEnvironmentIds, useEnvironmentBotRooms, useBotInbox } from "../../state/bots";
import { useQuietThreadShell } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { useMessageTimeFormatter } from "../threads/useMessageTimeFormatter";
import { BotGlyph } from "./BotGlyph";
import { botInboxItem, partitionBots } from "./bot-list";
import { partitionRooms } from "./bot-room";

function UnreadDot() {
  return <View className="size-2 rounded-full bg-primary" />;
}

function PinnedBot({
  entry,
  onOpen,
}: {
  readonly entry: EnvironmentBot;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  const { environmentId, bot } = entry;
  const { unread } = botInboxItem(
    useQuietThreadShell(scopeThreadRef(environmentId, bot.dmThreadId)),
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread ? gt("{name}, unread", { name: bot.name }) : bot.name}
      className="w-[68px] items-center gap-2.5 active:opacity-70"
      onPress={onOpen}
    >
      <View className="size-[68px] items-center justify-center rounded-full border border-border-subtle">
        <BotGlyph glyph={bot.avatar} size={28} colorClassName="accent-foreground" />
        {unread ? (
          <View className="absolute end-1 top-1">
            <UnreadDot />
          </View>
        ) : null}
      </View>
      <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
        {bot.name}
      </Text>
    </Pressable>
  );
}

export function BotRow({
  entry,
  onOpen,
  formatTime,
}: {
  readonly entry: EnvironmentBot;
  readonly onOpen: () => void;
  readonly formatTime?: (timestamp: string) => string;
}) {
  const gt = useGT();
  const { environmentId, bot } = entry;
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, bot.dmThreadId));
  const { preview, timestamp, unread } = botInboxItem(shell);
  const archived = bot.archivedAt !== null;
  const detail = archived
    ? bot.title
    : preview?.kind === "question"
      ? gt("Question needs an answer")
      : preview?.kind === "working"
        ? gt("Working…")
        : preview?.kind === "message"
          ? preview.text
          : bot.title;
  const time = timestamp === null ? undefined : formatTime?.(timestamp);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[bot.name, detail, time, !archived && unread ? gt("Unread") : ""]
        .filter(Boolean)
        .join(", ")}
      className="min-h-[65px] flex-row items-center gap-3 active:bg-subtle"
      onPress={onOpen}
    >
      <View className="size-11 items-center justify-center rounded-xl border border-border-subtle">
        <BotGlyph
          glyph={bot.avatar}
          size={22}
          colorClassName={archived ? "accent-icon-muted" : "accent-foreground"}
        />
      </View>
      <View className="min-h-[65px] min-w-0 flex-1 justify-center gap-0.5 border-b border-border-subtle py-2.5">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-semibold text-foreground"
            numberOfLines={1}
          >
            {bot.name}
          </Text>
          {time ? <Text className="text-2xs text-foreground-muted">{time}</Text> : null}
        </View>
        {detail ? (
          <View className="flex-row items-center gap-1.5 pe-5">
            {!archived && preview?.kind === "question" ? (
              <SymbolView name="list.number" size={13} tintColorClassName="accent-icon-muted" />
            ) : null}
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
              {detail}
            </Text>
          </View>
        ) : null}
      </View>
      {archived ? (
        <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-muted" />
      ) : (
        <View className="absolute bottom-5 end-0">
          {unread ? (
            <UnreadDot />
          ) : preview?.kind === "working" ? (
            <AppActivityIndicator
              size="small"
              colorClassName="accent-icon-muted"
              style={{ width: 12, height: 12 }}
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function BotsScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const selectDetail = useSelectWorkspaceDetail();
  const environmentId = useBotEnvironmentIds()[0];
  const canCreate = useEnvironmentScope(environmentId ?? null, AuthOrchestrationOperateScope);
  const workspace = useWorkspaceTabs();
  const tab = workspace?.state.tabs.bots;
  const query = tab?.query ?? "";
  const searching = (tab?.searchMode ?? "resting") !== "resting";
  const { ordered, pinned } = useBotInbox();
  const { active, archived } = partitionBots(ordered, query);
  const formatTime = useMessageTimeFormatter(gt("Yesterday"));
  const rooms = partitionRooms(useEnvironmentBotRooms(), query);
  const open = (entry: EnvironmentBot) => {
    selectDetail({
      name: "Thread",
      params: { environmentId: entry.environmentId, threadId: entry.bot.dmThreadId },
    });
  };
  const createBot = () => {
    if (environmentId !== undefined) navigation.navigate("BotEditor", { environmentId });
  };
  if (environmentId === undefined) {
    return (
      <EmptyState
        variant="plain"
        title={gt("Bots are not available")}
        detail={gt("Connect an environment that supports bots to see them here.")}
      />
    );
  }
  const empty = ordered.length === 0 && rooms.length === 0 && !searching;
  const showArchived = archived.length > 0;
  return (
    <ScreenScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: workspace?.bottomClearance ?? insets.bottom + 72,
      }}
    >
      {empty ? (
        <View className="flex-1 items-center justify-center gap-5 pb-24">
          <View className="size-16 items-center justify-center rounded-[22px] border border-border-subtle">
            <BotGlyph glyph="bot" size={32} colorClassName="accent-icon-muted" />
          </View>
          <View className="items-center gap-2">
            <Text className="text-xl text-foreground" style={{ fontWeight: "700" }}>
              {gt("No bots yet")}
            </Text>
            <Text className="max-w-72 text-center text-base text-foreground-muted">
              {gt("Create a bot with its own persona and a private chat.")}
            </Text>
          </View>
          {canCreate ? (
            <Pressable
              accessibilityRole="button"
              onPress={createBot}
              className="min-h-12 justify-center rounded-full border border-foreground-muted px-10 active:bg-subtle"
            >
              <Text className="text-base font-semibold text-foreground">{gt("New bot")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          {!searching && pinned.length > 0 ? (
            <View className="mb-7 gap-2">
              <Text className="text-xs font-semibold text-foreground-muted">{gt("Pinned")}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 20 }}
              >
                {pinned.map((entry) => (
                  <PinnedBot
                    key={`${entry.environmentId}:${entry.bot.id}`}
                    entry={entry}
                    onOpen={() => open(entry)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
          {active.length > 0 || searching ? (
            <Text className="mb-1 text-xs font-semibold text-foreground-muted">
              {searching
                ? gt("{count, plural, one {{count} bot} other {{count} bots}}", {
                    count: active.length,
                  })
                : gt("All bots")}
            </Text>
          ) : null}
          {active.map((entry) => (
            <BotRow
              key={`${entry.environmentId}:${entry.bot.id}`}
              entry={entry}
              formatTime={formatTime}
              onOpen={() => open(entry)}
            />
          ))}
          {!searching || rooms.length > 0 ? (
            <View className="mt-5 min-h-10 flex-row items-center justify-between">
              <Text className="text-xs font-semibold text-foreground-muted">{gt("Rooms")}</Text>
              {canCreate && active.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("New room")}
                  className="size-11 items-center justify-center"
                  onPress={() => navigation.navigate("BotRoomEditor", { environmentId })}
                >
                  <SymbolView name="plus" size={18} tintColorClassName="accent-icon-muted" />
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {rooms.map(({ environmentId: roomEnvironmentId, room }) => (
            <Pressable
              key={`${roomEnvironmentId}:${room.id}`}
              accessibilityRole="button"
              className="min-h-[54px] flex-row items-center gap-3 border-b border-border-subtle active:bg-subtle"
              onPress={() =>
                navigation.dispatch(
                  StackActions.push("BotRoom", {
                    environmentId: String(roomEnvironmentId),
                    roomId: room.id,
                  }),
                )
              }
            >
              <SymbolView
                name="bubble.left.and.bubble.right"
                size={20}
                tintColorClassName="accent-icon-muted"
              />
              <Text
                className={cn(
                  "min-w-0 flex-1 text-base",
                  room.archivedAt === null ? "text-foreground" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {room.name}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {room.archivedAt === null
                  ? gt("{count, plural, one {{count} bot} other {{count} bots}}", {
                      count: room.memberBotIds.length,
                    })
                  : gt("Archived")}
              </Text>
              <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-muted" />
            </Pressable>
          ))}
          {showArchived ? (
            <Pressable
              accessibilityRole="button"
              className="mt-2 min-h-[54px] flex-row items-center gap-3 active:bg-subtle"
              onPress={() => navigation.dispatch(StackActions.push("ArchivedBots", { query }))}
            >
              <SymbolView name="archivebox" size={20} tintColorClassName="accent-icon-muted" />
              <Text className="flex-1 text-base text-foreground">{gt("Archived")}</Text>
              <Text className="text-sm text-foreground-muted">
                {gt("{count, plural, one {{count} bot} other {{count} bots}}", {
                  count: archived.length,
                })}
              </Text>
              <SymbolView name="chevron.right" size={13} tintColorClassName="accent-icon-muted" />
            </Pressable>
          ) : null}
        </>
      )}
    </ScreenScrollView>
  );
}
