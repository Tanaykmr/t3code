import { botActivity, type EnvironmentBot } from "@t3tools/client-runtime/state/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useBotEnvironmentIds, useEnvironmentBots } from "../../state/bots";
import { useQuietThreadShell } from "../../state/entities";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { BotGlyph } from "./BotGlyph";
import { partitionBots } from "./bot-list";

function BotRow(props: { readonly entry: EnvironmentBot; readonly onOpen: () => void }) {
  const gt = useGT();
  const { environmentId, bot } = props.entry;
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, bot.dmThreadId));
  const activity = botActivity(shell);
  const archived = bot.archivedAt !== null;
  const status =
    activity === "unread" ? gt("unread reply") : activity === "working" ? gt("working") : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[bot.name, bot.title, status].filter(Boolean).join(", ")}
      className="flex-row items-center gap-3 border-b border-border-subtle px-5 py-3 active:bg-subtle"
      onPress={props.onOpen}
    >
      <BotGlyph
        glyph={bot.avatar}
        size={22}
        colorClassName={archived ? "accent-icon-muted" : "accent-foreground"}
      />
      <View className="min-w-0 flex-1">
        <Text
          className={cn(
            "font-t3-medium text-base",
            archived ? "text-foreground-muted" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {bot.name}
        </Text>
        {bot.title === "" ? null : (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {bot.title}
          </Text>
        )}
      </View>
      {activity === "idle" ? null : (
        <View
          className={cn(
            "size-2 rounded-full",
            activity === "unread" ? "bg-primary" : "bg-foreground-muted/60",
          )}
        />
      )}
    </Pressable>
  );
}

/** The Bots tab: one row per bot, each opening its private chat as the selected thread. */
export function BotsScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const selectDetail = useSelectWorkspaceDetail();
  const environmentIds = useBotEnvironmentIds();
  const workspace = useWorkspaceTabs();
  const query = workspace?.state.tabs.bots.query ?? "";
  const { active, archived } = partitionBots(useEnvironmentBots(), query);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const environmentId = environmentIds[0];
  const open = (entry: EnvironmentBot) =>
    selectDetail({
      name: "Thread",
      params: {
        environmentId: String(entry.environmentId),
        threadId: String(entry.bot.dmThreadId),
      },
    });
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
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
    >
      <Pressable
        accessibilityRole="button"
        className="flex-row items-center gap-3 border-b border-border-subtle px-5 py-3 active:bg-subtle"
        onPress={createBot}
      >
        <SymbolView name="plus" size={20} tintColorClassName="accent-primary-text" />
        <Text className="font-t3-medium text-base text-primary-text">{gt("New bot")}</Text>
      </Pressable>
      {active.length === 0 && query.trim() !== "" ? (
        <Text className="px-5 py-6 text-center text-sm text-foreground-muted">
          {gt("No bots match.")}
        </Text>
      ) : active.length === 0 ? (
        <EmptyState
          variant="plain"
          title={gt("No bots yet")}
          detail={gt("A bot is a named agent with its own persona and a private chat.")}
        />
      ) : (
        active.map((entry) => (
          <BotRow
            key={`${entry.environmentId}:${entry.bot.id}`}
            entry={entry}
            onOpen={() => open(entry)}
          />
        ))
      )}
      {archived.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: archivedOpen }}
          className="px-5 pb-1 pt-4"
          onPress={() => setArchivedOpen(!archivedOpen)}
        >
          <Text className="font-t3-medium text-xs text-foreground-muted">
            {gt("Archived · {count}", { count: String(archived.length) })}
          </Text>
        </Pressable>
      ) : null}
      {archivedOpen
        ? archived.map((entry) => (
            <BotRow
              key={`${entry.environmentId}:${entry.bot.id}`}
              entry={entry}
              onOpen={() => open(entry)}
            />
          ))
        : null}
    </ScreenScrollView>
  );
}
