import { mentionsInText } from "@t3tools/client-runtime/state/bots";
import type { BotMention } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Bots picked from a DM composer's @-menu, by composer target. Only picked bots
 * route; a typed `@Name` with no pick is plain text.
 */
const useBotMentionChips = create<{ byTarget: Record<string, ReadonlyArray<BotMention>> }>(() => ({
  byTarget: {},
}));

export function addBotMentionChip(targetKey: string, mention: BotMention) {
  useBotMentionChips.setState((state) => ({
    byTarget: {
      ...state.byTarget,
      [targetKey]: [...(state.byTarget[targetKey] ?? []), mention],
    },
  }));
}

/** The picked bots still named in `text`, in pick order. */
export function botMentionsIn(targetKey: string, text: string): ReadonlyArray<BotMention> {
  return mentionsInText(text, useBotMentionChips.getState().byTarget[targetKey] ?? []);
}

export function clearBotMentionChips(targetKey: string) {
  useBotMentionChips.setState((state) => {
    const { [targetKey]: _cleared, ...rest } = state.byTarget;
    return { byTarget: rest };
  });
}
