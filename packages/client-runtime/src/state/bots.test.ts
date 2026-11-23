import { BotId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { botActivity, botDmThreadKeys, isValidBotName, sortBots } from "./bots.ts";

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
});
