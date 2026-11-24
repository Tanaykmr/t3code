import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type BotId, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { FitSheet } from "../../components/ui/FitSheet";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useEnvironmentBots } from "../../state/bots";
import { useProject, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotGlyph } from "./BotGlyph";
import { BotKnowledge } from "./BotKnowledge";
import { BotRoutines } from "./BotRoutines";
import { deliveriesByMessage, newestMessages } from "./bot-room";

export type BotOverviewParams = {
  readonly environmentId: string;
  readonly botId: string;
};

function OverviewRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
}) {
  const content = (
    <>
      <SymbolView name={props.icon} size={18} tintColorClassName="accent-icon-muted" />
      <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      {props.detail ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.detail}
        </Text>
      ) : null}
    </>
  );
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle py-3 active:opacity-60"
      onPress={props.onPress}
    >
      {content}
    </Pressable>
  ) : (
    <View className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle py-3">
      {content}
    </View>
  );
}

/** A bot's overview, opened from its chat header: profile, home project, archive and restore. */
export function BotOverviewScreen({ route }: StaticScreenProps<BotOverviewParams>) {
  const gt = useGT();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const bot =
    useEnvironmentBots().find(
      (entry) => entry.environmentId === environmentId && entry.bot.id === route.params.botId,
    )?.bot ?? null;
  const project = useProject(bot === null ? null : scopeProjectRef(environmentId, bot.projectId));
  const projectTitles = new Map(
    useProjects()
      .filter((candidate) => candidate.environmentId === environmentId)
      .map((candidate) => [candidate.id as string, candidate.title]),
  );
  const workTargets = (bot?.allowedProjectIds ?? [])
    .flatMap((projectId) => projectTitles.get(projectId) ?? [])
    .join(", ");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = useAtomCommand(serverEnvironment.archiveBot, { reportFailure: false });
  const restore = useAtomCommand(serverEnvironment.restoreBot, { reportFailure: false });
  const archived = bot?.archivedAt != null;

  const toggleArchive = async () => {
    if (bot === null || busy) return;
    setBusy(true);
    setError(null);
    const result = await (archived ? restore : archive)({
      environmentId,
      input: { botId: bot.id },
    });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : archived
            ? gt("Could not restore bot")
            : gt("Could not archive bot"),
      );
    }
  };

  return (
    <FitSheet
      header={<SheetHeader title={gt("Overview")} onCancel={() => navigation.goBack()} />}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 }}
    >
      {bot === null ? (
        <Text className="py-6 text-center text-sm text-foreground-muted">
          {gt("This bot is no longer available.")}
        </Text>
      ) : (
        <View className="gap-3">
          <View className="flex-row items-start gap-3">
            <BotGlyph glyph={bot.avatar} size={28} colorClassName="accent-foreground" />
            <View className="min-w-0 flex-1">
              <Text className="font-t3-bold text-xl text-foreground" numberOfLines={1}>
                {bot.name}
              </Text>
              {bot.title === "" ? null : (
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {bot.title}
                </Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Edit {name}", { name: bot.name })}
              hitSlop={8}
              onPress={() =>
                navigation.navigate("BotEditor", {
                  environmentId: route.params.environmentId,
                  botId: bot.id,
                })
              }
            >
              <Text className="text-base text-primary-text">{gt("Edit")}</Text>
            </Pressable>
          </View>
          {bot.persona.trim() === "" ? null : (
            <Text className="text-sm leading-normal text-foreground-muted">{bot.persona}</Text>
          )}
          {archived ? (
            <Text className="text-sm text-foreground-muted">
              {gt("Archived. Restore it to chat again.")}
            </Text>
          ) : null}
          <View>
            <OverviewRow icon="folder" label={gt("Home project")} detail={project?.title ?? ""} />
            {workTargets === "" ? null : (
              <OverviewRow
                icon="arrow.triangle.branch"
                label={gt("Work targets")}
                detail={workTargets}
              />
            )}
            <OverviewRow
              icon={archived ? "tray.and.arrow.up" : "tray.and.arrow.down"}
              label={archived ? gt("Restore bot") : gt("Archive bot")}
              disabled={busy}
              onPress={() => void toggleArchive()}
            />
          </View>
          {error ? (
            <Text selectable className="text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
          <BotRoutines environmentId={environmentId} dmThreadId={bot.dmThreadId} />
          <BotKnowledge environmentId={environmentId} botId={bot.id} />
          <BotMessages environmentId={environmentId} botId={bot.id} />
        </View>
      )}
    </FitSheet>
  );
}

const BOT_MESSAGE_ROWS = 5;

const DELIVERY_STATUS_LABEL = {
  queued: msg("Queued", { $context: "bot delivery status" }),
  accepted: msg("Working", { $context: "bot delivery status" }),
  settled: msg("Delivered", { $context: "bot delivery status" }),
  blocked: msg("Blocked", { $context: "bot delivery status" }),
  cancelled: msg("Stopped", { $context: "bot delivery status" }),
} as const;

/** Messages this bot exchanged with other bots, and hand-offs out of its chat, newest first. */
function BotMessages(props: { readonly environmentId: EnvironmentId; readonly botId: BotId }) {
  const gt = useGT();
  const m = useMessages();
  const channel = AsyncResult.getOrElse(
    useAtomValue(
      serverEnvironment.botChannelLive({
        environmentId: props.environmentId,
        input: { kind: "bot", botId: props.botId },
      }),
    ),
    () => null,
  );
  const names = new Map(useEnvironmentBots().map(({ bot }) => [bot.id as string, bot.name]));
  const byMessage = deliveriesByMessage(channel?.deliveries ?? []);
  const rows = newestMessages(channel?.messages ?? [], BOT_MESSAGE_ROWS);
  if (rows.length === 0) return null;
  return (
    <View className="gap-3 border-t border-border-subtle pt-3">
      <Text className="font-t3-medium text-xs text-foreground-muted">{gt("Bot messages")}</Text>
      {rows.map((message) => {
        const from =
          message.sender.kind === "bot"
            ? (names.get(message.sender.botId) ?? gt("Bot"))
            : gt("You");
        const deliveries = byMessage.get(message.id) ?? [];
        const to = deliveries.map((d) => names.get(d.targetBotId) ?? gt("Bot")).join(", ");
        const status = deliveries[0]?.status;
        return (
          <View key={message.id} className="gap-0.5">
            <Text className="text-xs text-foreground-muted">
              {(to === "" ? from : gt("{from} to {to}", { from, to })) +
                (status === undefined ? "" : ` · ${m(DELIVERY_STATUS_LABEL[status])}`)}
            </Text>
            <Text className="text-sm text-foreground" numberOfLines={2}>
              {message.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
