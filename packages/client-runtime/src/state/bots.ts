import type { Bot, BotMention, BotRoom, EnvironmentId } from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";

export interface EnvironmentBot {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export interface EnvironmentBotRoom {
  readonly environmentId: EnvironmentId;
  readonly room: BotRoom;
}

/**
 * The threads bots own (DMs and room seats), keyed like thread shells, so
 * thread lists can leave them out.
 */
export function botDmThreadKeys(
  entries: ReadonlyArray<EnvironmentBot>,
  rooms: ReadonlyArray<EnvironmentBotRoom> = [],
): ReadonlySet<string> {
  return new Set([
    ...entries.flatMap(({ environmentId, bot }) => [
      scopedThreadKey({ environmentId, threadId: bot.dmThreadId }),
      ...(bot.peerThreadId == null
        ? []
        : [scopedThreadKey({ environmentId, threadId: bot.peerThreadId })]),
    ]),
    ...rooms.flatMap(({ environmentId, room }) =>
      room.participants.map((seat) => scopedThreadKey({ environmentId, threadId: seat.threadId })),
    ),
  ]);
}

/**
 * The chips a composer keeps, in order, for names still present in the text. A typed
 * `@Name` with no chip routes nowhere.
 */
export function mentionsInText(
  text: string,
  chips: ReadonlyArray<BotMention>,
): ReadonlyArray<BotMention> {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    if (seen.has(chip.botId) || !namesMention(text, chip.label)) return false;
    seen.add(chip.botId);
    return true;
  });
}

const MENTION_NAME_CHAR = /[\p{L}\p{N}_.-]/u;

/** `@label` as a whole token: picking `@Ada` and then typing `@Adam` names Adam, not Ada. */
function namesMention(text: string, label: string): boolean {
  const token = `@${label}`;
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const end = at + token.length;
    const next = text[end];
    // A trailing "." or "-" is punctuation unless the name goes on after it.
    const continues =
      next !== undefined &&
      MENTION_NAME_CHAR.test(next) &&
      !(/[.-]/.test(next) && !MENTION_NAME_CHAR.test(text[end + 1] ?? " "));
    if (!continues) return true;
  }
  return false;
}

/** The `@query` being typed at the caret, if any. */
/**
 * Where a DM send goes: `handoff` lists the other picked bots, and `skipThread` is true when
 * the DM's own bot was not picked, so it stays idle. A handoff carries text only, so a draft
 * with attachments or context is `blocked` rather than sent without them.
 */
export function resolveBotHandoff(
  mentions: ReadonlyArray<BotMention>,
  dmBotId: string,
  hasAttachments: boolean,
): {
  readonly handoff: ReadonlyArray<BotMention>;
  readonly skipThread: boolean;
  readonly blocked: boolean;
} {
  const handoff = mentions.filter((mention) => mention.botId !== dmBotId);
  return {
    handoff,
    skipThread: handoff.length > 0 && handoff.length === mentions.length,
    blocked: handoff.length > 0 && hasAttachments,
  };
}

export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const match = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(text.slice(0, caret));
  if (match === null) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
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
