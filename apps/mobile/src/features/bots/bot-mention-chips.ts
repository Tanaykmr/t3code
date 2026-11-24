import { mentionsInText } from "@t3tools/client-runtime/state/bots";
import type { BotMention } from "@t3tools/contracts";

/**
 * Bots picked from a DM composer's @-menu, by composer draft key. Only picked bots
 * route; a typed `@Name` with no pick is plain text. Read only at send, so it needs
 * no subscribers.
 */
const chipsByDraft = new Map<string, ReadonlyArray<BotMention>>();

export function addBotMentionChip(draftKey: string, mention: BotMention) {
  chipsByDraft.set(draftKey, [...(chipsByDraft.get(draftKey) ?? []), mention]);
}

/** The picked bots still named in `text`, in pick order. */
export function botMentionsIn(draftKey: string, text: string): ReadonlyArray<BotMention> {
  return mentionsInText(text, chipsByDraft.get(draftKey) ?? []);
}

export function clearBotMentionChips(draftKey: string) {
  chipsByDraft.delete(draftKey);
  handoffIdByDraft.delete(draftKey);
}

const handoffIdByDraft = new Map<string, { readonly id: string; readonly signature: string }>();

/**
 * One handoff id per submission: a retry of the same text and picks reuses it, so a
 * resend after a lost reply wakes nobody twice; any edit starts a new one.
 */
export function handoffIdFor(
  draftKey: string,
  text: string,
  mentions: ReadonlyArray<BotMention>,
  newId: () => string,
): string {
  const signature = JSON.stringify([text, mentions.map((mention) => mention.botId)]);
  const current = handoffIdByDraft.get(draftKey);
  if (current?.signature === signature) return current.id;
  const id = newId();
  handoffIdByDraft.set(draftKey, { id, signature });
  return id;
}

/**
 * Where a DM send goes: `handoff` lists the other picked bots, and `skipThread` is true
 * when the DM's own bot was not picked, so it stays idle.
 */
export function resolveBotHandoff(
  mentions: ReadonlyArray<BotMention>,
  dmBotId: string,
): { readonly handoff: ReadonlyArray<BotMention>; readonly skipThread: boolean } {
  const handoff = mentions.filter((mention) => mention.botId !== dmBotId);
  return { handoff, skipThread: handoff.length > 0 && handoff.length === mentions.length };
}
