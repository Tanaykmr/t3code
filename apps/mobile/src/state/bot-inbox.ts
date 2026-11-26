import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentBot } from "@t3tools/client-runtime/state/bots";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { orderBotInbox, pinnedBots } from "../features/bots/bot-list";
import { environmentBotsAtom } from "./bots";
import { environmentThreadShells } from "./threads";

const botInboxAtom = Atom.make((get) => {
  const entries = get(environmentBotsAtom);
  const shellFor = ({ environmentId, bot }: EnvironmentBot) =>
    get(
      environmentThreadShells.quietThreadShellAtom(scopeThreadRef(environmentId, bot.dmThreadId)),
    );
  const ordered = orderBotInbox(entries, shellFor);
  const pinned = pinnedBots(entries, shellFor);
  const previous = Option.getOrNull(get.self<{ ordered: typeof ordered; pinned: typeof pinned }>());
  return previous !== null &&
    previous.ordered.length === ordered.length &&
    ordered.every((entry, index) => entry === previous.ordered[index]) &&
    previous.pinned.length === pinned.length &&
    pinned.every((entry, index) => entry === previous.pinned[index])
    ? previous
    : { ordered, pinned };
}).pipe(Atom.withLabel("mobile-bot-inbox"));

export function useBotInbox() {
  return useAtomValue(botInboxAtom);
}
