import { type EnvironmentBot, resolveBotHandoff } from "@t3tools/client-runtime/state/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { BotMessageId } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { botMentionsIn, clearBotMentionChips } from "./botMentionChips";

/** What a send in a bot's DM did with its picked @-chips. */
export type BotHandoffOutcome =
  /** No other bot was picked: send normally. */
  | "none"
  /** Handed off and the DM's own bot was picked too: send normally as well. */
  | "handed-off"
  /** Handed off only to other bots: skip the normal send and clear the draft. */
  | "handed-off-only"
  /** The handoff failed: keep the draft. */
  | "failed";

// One id per draft and submission, so a retry after a lost reply hands off once.
const pendingHandoffs = new Map<string, { readonly key: string; readonly messageId: string }>();

/**
 * In a bot's DM, picked @-chips hand the message to those bots. The DM's own bot
 * runs only when it is picked too, or when nothing is picked.
 */
export function useBotHandoffSend(input: {
  readonly activeBot: EnvironmentBot | null;
  readonly targetKey: string;
  readonly hasAttachments: boolean;
}) {
  const handoff = useAtomCommand(serverEnvironment.handoffToBots, { label: "bot handoff" });
  return async (prompt: string): Promise<BotHandoffOutcome> => {
    const { activeBot, targetKey } = input;
    if (activeBot === null) return "none";
    const {
      handoff: others,
      skipThread,
      blocked,
    } = resolveBotHandoff(botMentionsIn(targetKey, prompt), activeBot.bot.id, input.hasAttachments);
    if (others.length === 0) return "none";
    if (blocked) {
      toastManager.add({
        type: "error",
        title: m(msg("Attachments can't go to another bot")),
        description: m(msg("Remove them, or send without picking another bot.")),
      });
      return "failed";
    }
    const text = prompt.trim();
    const key = `${targetKey}\u0000${text}\u0000${others.map((m) => m.botId).join(",")}`;
    let pending = pendingHandoffs.get(targetKey);
    if (pending?.key !== key) {
      pending = { key, messageId: randomUUID() };
      pendingHandoffs.set(targetKey, pending);
    }
    const result = await handoff({
      environmentId: activeBot.environmentId,
      input: {
        botId: activeBot.bot.id,
        messageId: BotMessageId.make(pending.messageId),
        text,
        mentions: others,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: m(msg("Could not hand off to the bot")),
          description: String(squashAtomCommandFailure(result)),
        });
      }
      return "failed";
    }
    if (pendingHandoffs.get(targetKey)?.key === key) pendingHandoffs.delete(targetKey);
    clearBotMentionChips(targetKey);
    toastManager.add({
      type: "success",
      title: m(msg("Sent to {bots}"), { bots: others.map((mention) => mention.label).join(", ") }),
    });
    return skipThread ? "handed-off-only" : "handed-off";
  };
}
