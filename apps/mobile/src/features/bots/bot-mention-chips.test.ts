import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addBotMentionChip,
  botMentionsIn,
  clearBotMentionChips,
  handoffIdFor,
} from "./bot-mention-chips";

const bolt = { botId: BotId.make("bolt"), label: "Bolt" };

describe("bot mention chips", () => {
  it("routes only picked bots still in the text", () => {
    addBotMentionChip("draft", bolt);
    expect(botMentionsIn("draft", "@Bolt look at this")).toEqual([bolt]);
    expect(botMentionsIn("draft", "never mind")).toEqual([]);
    expect(botMentionsIn("other", "@Bolt typed, not picked")).toEqual([]);
    clearBotMentionChips("draft");
    expect(botMentionsIn("draft", "@Bolt look at this")).toEqual([]);
  });

  it("keeps one handoff id per submission until an edit or a success", () => {
    let next = 0;
    const newId = () => `id-${++next}`;
    expect(handoffIdFor("dm", "@Bolt look", [bolt], newId)).toBe("id-1");
    // A retry of the same text and picks reuses it.
    expect(handoffIdFor("dm", "@Bolt look", [bolt], newId)).toBe("id-1");
    // An edit is a new submission.
    expect(handoffIdFor("dm", "@Bolt look again", [bolt], newId)).toBe("id-2");
    clearBotMentionChips("dm");
    expect(handoffIdFor("dm", "@Bolt look again", [bolt], newId)).toBe("id-3");
  });
});
