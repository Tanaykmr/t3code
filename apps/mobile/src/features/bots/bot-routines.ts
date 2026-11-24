import type { ScheduledTask, ThreadId } from "@t3tools/contracts";

type RoutineFields = Pick<ScheduledTask, "threadId" | "enabled" | "title">;

/** A bot's routines are the scheduled tasks bound to its DM: running ones first, then by title. */
export function routinesForThread<Task extends RoutineFields>(
  tasks: ReadonlyArray<Task>,
  threadId: ThreadId,
): ReadonlyArray<Task> {
  return tasks
    .filter((task) => task.threadId === threadId)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.title.localeCompare(b.title));
}
