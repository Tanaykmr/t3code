import type { Bot, EnvironmentId } from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";

export interface EnvironmentBot {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The DM threads bots own, keyed like thread shells, so thread lists can leave them out. */
export function botDmThreadKeys(entries: ReadonlyArray<EnvironmentBot>): ReadonlySet<string> {
  return new Set(
    entries.map(({ environmentId, bot }) =>
      scopedThreadKey({ environmentId, threadId: bot.dmThreadId }),
    ),
  );
}

export function sortBots(entries: ReadonlyArray<EnvironmentBot>): ReadonlyArray<EnvironmentBot> {
  return [...entries].sort((a, b) =>
    a.bot.name.localeCompare(b.bot.name, undefined, { sensitivity: "base" }),
  );
}

interface BotDmShell {
  readonly lastVisitedAt?: string | null | undefined;
  readonly latestRun: {
    readonly status: string;
    readonly completedAt: string | null;
  } | null;
}

export type BotActivity = "working" | "unread" | "idle";

/**
 * Unread is the DM thread's own visit watermark, which every device shares: a
 * reply finished after the operator last looked at the DM.
 */
export function botActivity(shell: BotDmShell | null): BotActivity {
  const run = shell?.latestRun;
  if (run == null) return "idle";
  if (ACTIVE_RUN_STATUSES.has(run.status)) return "working";
  if (run.completedAt === null || run.status === "interrupted" || run.status === "cancelled") {
    return "idle";
  }
  const visitedAt = shell?.lastVisitedAt ? Date.parse(shell.lastVisitedAt) : Number.NaN;
  return Number.isNaN(visitedAt) || Date.parse(run.completedAt) > visitedAt ? "unread" : "idle";
}

/** A new bot's name: a mention token, so letters, digits, `_`, `.` and `-` only. */
export function isValidBotName(name: string): boolean {
  return /^[\p{L}\p{N}_.-]+$/u.test(name.trim());
}
