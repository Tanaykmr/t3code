import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addBotMentionChip,
  botMentionsIn,
  clearBotMentionChips,
  resolveBotHandoff,
} from "./bot-mention-chips";

const bolt = { botId: BotId.make("bolt"), label: "Bolt" };
const ada = { botId: BotId.make("ada"), label: "Ada" };

describe("bot mention chips", () => {
  it("routes only picked bots still in the text", () => {
    addBotMentionChip("draft", bolt);
    expect(botMentionsIn("draft", "@Bolt look at this")).toEqual([bolt]);
    expect(botMentionsIn("draft", "never mind")).toEqual([]);
    expect(botMentionsIn("other", "@Bolt typed, not picked")).toEqual([]);
    clearBotMentionChips("draft");
    expect(botMentionsIn("draft", "@Bolt look at this")).toEqual([]);
  });

  it("keeps the DM's own bot idle unless it is picked too", () => {
    expect(resolveBotHandoff([bolt], "ada")).toEqual({ handoff: [bolt], skipThread: true });
    expect(resolveBotHandoff([ada, bolt], "ada")).toEqual({ handoff: [bolt], skipThread: false });
    expect(resolveBotHandoff([], "ada")).toEqual({ handoff: [], skipThread: false });
  });
});
