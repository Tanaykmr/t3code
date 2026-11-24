import { BotId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { botDmThreadKeys } from "@t3tools/client-runtime/state/bots";
import { describe, expect, it } from "vite-plus/test";

import { partitionBots, withoutBotDms } from "./bot-list";

const environmentId = EnvironmentId.make("env");
const bot = (name: string, title: string, archived = false) => ({
  environmentId,
  bot: {
    id: BotId.make(`bot-${name}`),
    name,
    title,
    avatar: "bot" as const,
    persona: "",
    personaRevision: 1,
    dmThreadId: ThreadId.make(`dm-${name}`),
    projectId: ProjectId.make("project"),
    allowedProjectIds: [],
    peerThreadId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: archived ? "2026-01-02T00:00:00.000Z" : null,
  },
});

describe("bot list", () => {
  it("leaves bot DMs out of thread lists and keeps an unchanged list's identity", () => {
    const shells = [
      { environmentId, id: "dm-Ada" },
      { environmentId, id: "ordinary" },
    ];
    const keys = botDmThreadKeys([bot("Ada", "")]);
    expect(withoutBotDms(shells, keys).map((shell) => shell.id)).toEqual(["ordinary"]);
    const ordinaryOnly = [{ environmentId, id: "ordinary" }];
    expect(withoutBotDms(ordinaryOnly, keys)).toBe(ordinaryOnly);
    expect(withoutBotDms(shells, new Set())).toBe(shells);
  });

  it("folds archived bots away and searches names and titles", () => {
    const entries = [bot("Ada", "Release engineer"), bot("Bolt", "Code reviewer", true)];
    const all = partitionBots(entries);
    expect(all.active.map((entry) => entry.bot.name)).toEqual(["Ada"]);
    expect(all.archived.map((entry) => entry.bot.name)).toEqual(["Bolt"]);
    expect(partitionBots(entries, "review").archived.map((entry) => entry.bot.name)).toEqual([
      "Bolt",
    ]);
    expect(partitionBots(entries, "release").active).toHaveLength(1);
    expect(partitionBots(entries, "nobody").active).toHaveLength(0);
  });
});
