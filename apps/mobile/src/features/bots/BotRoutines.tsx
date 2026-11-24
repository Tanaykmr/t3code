import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT, useLocale, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeSchedule } from "../settings/SettingsScheduledTasksRouteScreen";
import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";
import { routinesForThread } from "./bot-routines";

/**
 * Routines are scheduled tasks bound to the bot's DM. A bot creates them from chat with
 * schedule_task; here they pause, resume and run once.
 */
export function BotRoutines(props: {
  readonly environmentId: EnvironmentId;
  readonly dmThreadId: ThreadId;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot routine enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "bot routine run",
    reportFailure: false,
  });
  const now = useNowMinuteMs();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const routines = routinesForThread(tasks.data?.tasks ?? [], props.dmThreadId);
  if (routines.length === 0) return null;

  const act = async (task: ScheduledTask, action: "toggle" | "run") => {
    if (
      busyId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyId(task.id);
    setError(null);
    const result =
      action === "toggle"
        ? await setEnabled({
            environmentId: props.environmentId,
            input: { id: task.id, enabled: !task.enabled },
          })
        : await runNow({ environmentId: props.environmentId, input: { id: task.id } });
    setBusyId(null);
    if (AsyncResult.isFailure(result) && !isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : action === "toggle"
            ? gt("Could not update task")
            : gt("Could not run task"),
      );
    }
  };

  return (
    <View className="gap-3 border-t border-border-subtle pt-3">
      <Text className="font-t3-medium text-xs text-foreground-muted">{gt("Routines")}</Text>
      {routines.map((task) => {
        const schedule = describeSchedule(task, tasks.data?.timeZone, m, locale);
        const summary = !task.enabled
          ? gt("{schedule} · Paused", { schedule })
          : task.nextRunAt
            ? gt("{schedule} · {nextRun}", {
                schedule,
                nextRun: formatNextScheduledTaskRun(task.nextRunAt, now, m),
              })
            : schedule;
        return (
          <View key={task.id} className="flex-row items-center gap-3">
            <ThemedSwitch
              accessibilityLabel={task.enabled ? gt("Pause") : gt("Resume")}
              disabled={!canOperate || busyId === task.id}
              value={task.enabled}
              onValueChange={() => void act(task, "toggle")}
            />
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {task.title}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {summary}
              </Text>
            </View>
            {task.schedule.type === "webhook" ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Run {title} now", { title: task.title })}
                disabled={!canOperate || busyId === task.id}
                hitSlop={8}
                onPress={() => void act(task, "run")}
                className="active:opacity-60"
              >
                <SymbolView name="play" size={14} tintColorClassName="accent-icon-muted" />
              </Pressable>
            )}
          </View>
        );
      })}
      {error ? (
        <Text selectable className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
