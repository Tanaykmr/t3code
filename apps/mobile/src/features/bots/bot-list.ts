import type { EnvironmentBot } from "@t3tools/client-runtime/state/bots";

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
