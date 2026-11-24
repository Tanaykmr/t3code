import { BotId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botActivity,
  botDmThreadKeys,
  isValidBotName,
  mentionQueryAt,
  mentionsInText,
  resolveBotHandoff,
  sortBots,
} from "./bots.ts";

const bot = (name: string, thread: string) => ({
  environmentId: EnvironmentId.make("env"),
  bot: {
    id: BotId.make(`bot-${name}`),
    name,
    title: "",
    avatar: "bot" as const,
    persona: "",
    personaRevision: 1,
    dmThreadId: ThreadId.make(thread),
    projectId: ProjectId.make("project"),
    allowedProjectIds: [],
    peerThreadId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  },
});

describe("bots", () => {
  it("keys DM threads like thread shells and sorts by name", () => {
    const entries = [bot("bolt", "t2"), bot("Ada", "t1")];
    expect([...botDmThreadKeys(entries)]).toEqual(["env:t2", "env:t1"]);
    expect(sortBots(entries).map((entry) => entry.bot.name)).toEqual(["Ada", "bolt"]);
  });

  it("is unread only for a reply finished after the shared visit watermark", () => {
    const run = (status: string, completedAt: string | null) => ({ status, completedAt });
    expect(botActivity(null)).toBe("idle");
    expect(botActivity({ latestRun: run("running", null) })).toBe("working");
    expect(
      botActivity({
        lastVisitedAt: "2026-01-01T00:00:01Z",
        latestRun: run("completed", "2026-01-01T00:00:02Z"),
      }),
    ).toBe("unread");
    expect(
      botActivity({
        lastVisitedAt: "2026-01-01T00:00:03Z",
        latestRun: run("completed", "2026-01-01T00:00:02Z"),
      }),
    ).toBe("idle");
    expect(botActivity({ latestRun: run("cancelled", "2026-01-01T00:00:02Z") })).toBe("idle");
  });

  it("accepts only mention-safe names", () => {
    expect(isValidBotName("Ada")).toBe(true);
    expect(isValidBotName("code.reviewer-2")).toBe(true);
    expect(isValidBotName("Ada Lovelace")).toBe(false);
    expect(isValidBotName("@Ada")).toBe(false);
  });

  it("keeps only chips whose @name is still in the text, once each", () => {
    const bolt = { botId: BotId.make("bolt"), label: "Bolt" };
    const cora = { botId: BotId.make("cora"), label: "Cora" };
    expect(mentionsInText("@Bolt and @Bolt, look", [bolt, bolt, cora])).toEqual([bolt]);
    // Typing a name with no chip routes nowhere.
    expect(mentionsInText("@Cora hi", [])).toEqual([]);
    // A picked name edited into a longer one no longer routes to the picked bot.
    expect(mentionsInText("@Boltz, look", [bolt])).toEqual([]);
    expect(mentionsInText("ask @Bolt.", [bolt])).toEqual([bolt]);
  });

  it("finds the @query at the caret", () => {
    expect(mentionQueryAt("ask @Bo", 7)).toEqual({ start: 4, query: "Bo" });
    expect(mentionQueryAt("mail a@b", 8)).toBeNull();
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("keeps the DM's own bot idle unless picked, and holds a handoff with attachments", () => {
    const bolt = { botId: BotId.make("bolt"), label: "Bolt" };
    const ada = { botId: BotId.make("ada"), label: "Ada" };
    expect(resolveBotHandoff([bolt], "ada", false)).toEqual({
      handoff: [bolt],
      skipThread: true,
      blocked: false,
    });
    expect(resolveBotHandoff([ada, bolt], "ada", false)).toEqual({
      handoff: [bolt],
      skipThread: false,
      blocked: false,
    });
    expect(resolveBotHandoff([], "ada", true)).toEqual({
      handoff: [],
      skipThread: false,
      blocked: false,
    });
    // A handoff sends text only, so files or images must not silently drop out of it.
    expect(resolveBotHandoff([bolt], "ada", true).blocked).toBe(true);
  });
});
