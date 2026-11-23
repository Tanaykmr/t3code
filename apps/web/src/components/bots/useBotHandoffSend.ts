import type { EnvironmentBot } from "@t3tools/client-runtime/state/bots";
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

/**
 * In a bot's DM, picked @-chips hand the message to those bots. The DM's own bot
 * runs only when it is picked too, or when nothing is picked.
 * Resolves `true` when the message went only to other bots, so the caller skips its send.
 */
export function useBotHandoffSend(input: {
  readonly activeBot: EnvironmentBot | null;
  readonly targetKey: string;
}) {
  const handoff = useAtomCommand(serverEnvironment.handoffToBots, { label: "bot handoff" });
  return async (prompt: string): Promise<boolean> => {
    const { activeBot, targetKey } = input;
    if (activeBot === null) return false;
    const mentions = botMentionsIn(targetKey, prompt);
    const others = mentions.filter((mention) => mention.botId !== activeBot.bot.id);
    if (others.length === 0) return false;
    const result = await handoff({
      environmentId: activeBot.environmentId,
      input: {
        botId: activeBot.bot.id,
        messageId: BotMessageId.make(randomUUID()),
        text: prompt.trim(),
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
      return true;
    }
    clearBotMentionChips(targetKey);
    toastManager.add({
      type: "success",
      title: m(msg("Sent to {bots}"), { bots: others.map((mention) => mention.label).join(", ") }),
    });
    return others.length === mentions.length;
  };
}
