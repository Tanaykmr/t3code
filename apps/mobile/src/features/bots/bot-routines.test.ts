import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { routinesForThread } from "./bot-routines";

const dm = ThreadId.make("dm-ada");
const task = (title: string, threadId: ThreadId | null, enabled = true) => ({
  title,
  threadId,
  enabled,
});

describe("routinesForThread", () => {
  it("keeps only tasks bound to the DM, running ones first, then by title", () => {
    const tasks = [
      task("Weekly digest", dm, false),
      task("Standup", dm),
      task("Other bot", ThreadId.make("dm-bolt")),
      task("New thread each run", null),
      task("Cache check", dm),
    ];
    expect(routinesForThread(tasks, dm).map((routine) => routine.title)).toEqual([
      "Cache check",
      "Standup",
      "Weekly digest",
    ]);
    expect(tasks).toHaveLength(5);
  });
});
