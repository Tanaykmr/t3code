import { botActivity, type EnvironmentBot } from "@t3tools/client-runtime/state/bots";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { Bot, BotId, EnvironmentId } from "@t3tools/contracts";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import * as DateTime from "effect/DateTime";

interface KeyedShell {
  readonly environmentId: string;
  readonly id: string;
}

/** Bot DMs live in the Bots tab, so thread lists leave them out; an unchanged list keeps its identity. */
export function withoutBotDms<Shell extends KeyedShell>(
  shells: ReadonlyArray<Shell>,
  dmThreadKeys: ReadonlySet<string>,
): ReadonlyArray<Shell> {
  if (dmThreadKeys.size === 0) return shells;
  const kept = shells.filter((shell) => !dmThreadKeys.has(`${shell.environmentId}:${shell.id}`));
  return kept.length === shells.length ? shells : kept;
}

/** Bots matching the search, split into the listed ones and the archived ones the list folds away. */
export function partitionBots(entries: ReadonlyArray<EnvironmentBot>, query = "") {
  const needle = query.trim().toLowerCase();
  const matching =
    needle === ""
      ? entries
      : entries.filter(({ bot }) => `${bot.name} ${bot.title}`.toLowerCase().includes(needle));
  return {
    active: matching.filter((entry) => entry.bot.archivedAt === null),
    archived: matching.filter((entry) => entry.bot.archivedAt !== null),
  };
}

type BotDmShell = Pick<
  EnvironmentThreadShell,
  | "pinnedAt"
  | "pinOrderKey"
  | "hasPendingUserInput"
  | "pendingUserInputAt"
  | "lastVisitedAt"
  | "latestRun"
  | "source"
>;

export function botInboxItem(shell: BotDmShell | null) {
  const message = shell?.source.latestVisibleMessage;
  const messageAt = message == null ? null : DateTime.formatIso(message.updatedAt);
  const question = shell?.hasPendingUserInput === true;
  const questionAt = question ? (shell?.pendingUserInputAt ?? null) : null;
  const unreadQuestion =
    questionAt !== null &&
    (shell?.lastVisitedAt == null || Date.parse(questionAt) > Date.parse(shell.lastVisitedAt));
  const activity = botActivity(shell);
  return {
    preview: question
      ? ({ kind: "question" } as const)
      : activity === "working"
        ? ({ kind: "working" } as const)
        : message?.text.trim()
          ? ({ kind: "message", text: message.text } as const)
          : null,
    timestamp: questionAt ?? messageAt ?? shell?.latestRun?.completedAt ?? null,
    unread: unreadQuestion || activity === "unread",
  };
}

export function orderBotInbox(
  entries: ReadonlyArray<EnvironmentBot>,
  shellFor: (entry: EnvironmentBot) => BotDmShell | null,
) {
  return entries
    .map((entry) => ({ entry, timestamp: botInboxItem(shellFor(entry)).timestamp ?? "" }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map(({ entry }) => entry);
}

export function pinnedBots(
  active: ReadonlyArray<EnvironmentBot>,
  shellFor: (entry: EnvironmentBot) => BotDmShell | null,
) {
  return sortPinnedThreadsByOrderKey(
    active.flatMap((entry) => {
      if (entry.bot.archivedAt !== null) return [];
      const shell = shellFor(entry);
      return shell?.pinnedAt == null
        ? []
        : [
            {
              entry,
              id: entry.bot.dmThreadId,
              environmentId: entry.environmentId,
              createdAt: shell.pinnedAt,
              pinOrderKey: shell.pinOrderKey,
            },
          ];
    }),
  ).map(({ entry }) => entry);
}

export function botChatParams(
  entries: ReadonlyArray<EnvironmentBot>,
  environmentId: EnvironmentId,
  botId: BotId,
) {
  const entry = entries.find(
    (item) => item.environmentId === environmentId && item.bot.id === botId,
  );
  return entry ? { environmentId, threadId: entry.bot.dmThreadId } : null;
}

export function botChatIsArchived(
  bot: Pick<Bot, "archivedAt">,
  shell: Pick<EnvironmentThreadShell, "archivedAt">,
) {
  return bot.archivedAt !== null || shell.archivedAt !== null;
}
