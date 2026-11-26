import {
  BotId,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { botDmThreadKeys } from "@t3tools/client-runtime/state/bots";
import * as DateTime from "effect/DateTime";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { makeRawThreadShell } from "../../test-fixtures";
import { describe, expect, it } from "vite-plus/test";

import { botChatParams, botInboxItem, partitionBots, pinnedBots, withoutBotDms } from "./bot-list";

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

describe("bot inbox", () => {
  const at = (minute: number) => DateTime.makeUnsafe(`2026-11-24T09:${minute}:00Z`);
  const message = {
    id: MessageId.make("reply"),
    role: "assistant" as const,
    text: "The changelog is ready to review.",
    updatedAt: at(38),
  };

  it("reads the message and time from the DM shell and clears unread on a visit", () => {
    const raw = makeRawThreadShell({
      latestVisibleMessage: message,
      latestRunId: RunId.make("release"),
      latestRunCompletedAt: at(38),
      status: "completed",
      lastVisitedAt: at(37),
    });
    expect(botInboxItem(presentThreadShell(environmentId, raw))).toEqual({
      preview: { kind: "message", text: "The changelog is ready to review." },
      timestamp: "2026-11-24T09:38:00.000Z",
      unread: true,
    });
    expect(
      botInboxItem(presentThreadShell(environmentId, { ...raw, lastVisitedAt: at(38) })).unread,
    ).toBe(false);
  });

  it("shows an unseen question ahead of a streaming reply and keeps the marker after it is seen", () => {
    const run = RunId.make("release");
    const raw = makeRawThreadShell({
      latestVisibleMessage: message,
      latestRunId: run,
      activeRunId: run,
      status: "running",
      lastVisitedAt: at(38),
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("checks"),
        kind: "user_input",
        createdAt: at(39),
        blocking: false,
      },
    });
    expect(botInboxItem(presentThreadShell(environmentId, raw))).toEqual({
      preview: { kind: "question" },
      timestamp: "2026-11-24T09:39:00.000Z",
      unread: true,
    });
    expect(
      botInboxItem(presentThreadShell(environmentId, { ...raw, lastVisitedAt: at(39) })),
    ).toMatchObject({
      preview: { kind: "question" },
      unread: false,
    });
    expect(
      botInboxItem(presentThreadShell(environmentId, { ...raw, pendingRuntimeRequest: null })),
    ).toMatchObject({
      preview: { kind: "working" },
      unread: false,
    });
  });

  it("uses scoped DM pin order and skips archived and unpinned shortcuts", () => {
    const ada = bot("Ada", "Release engineer");
    const cora = { ...bot("Cora", "Writer"), environmentId: EnvironmentId.make("other") };
    const bolt = bot("Bolt", "Reviewer", true);
    const patch = bot("Patch", "Builder");
    const shells = new Map(
      [ada, cora, bolt].map(({ environmentId: environment, bot: entry }, index) => [
        environment + ":" + entry.dmThreadId,
        presentThreadShell(
          environment,
          makeRawThreadShell({
            pinnedAt: at(36),
            pinOrderKey: ["b", "a", "0"][index]!,
          }),
        ),
      ]),
    );
    const pins = pinnedBots(
      [ada, cora, bolt, patch],
      ({ environmentId: environment, bot: entry }) =>
        shells.get(environment + ":" + entry.dmThreadId) ?? null,
    );
    expect(pins.map(({ bot: entry }) => entry.name)).toEqual(["Cora", "Ada"]);
  });

  it("opens an archived chat using the environment and bot together", () => {
    const archived = bot("Ada", "Reviewer", true);
    const remote = {
      ...archived,
      environmentId: EnvironmentId.make("remote"),
      bot: { ...archived.bot, dmThreadId: ThreadId.make("remote-dm") },
    };
    expect(botChatParams([archived, remote], remote.environmentId, archived.bot.id)).toEqual({
      environmentId: "remote",
      threadId: "remote-dm",
    });
  });
});
