import { useAtomValue } from "@effect/atom-react";
import {
  type BoatAction,
  boatKeyRouteIsPrivate,
  BOAT_TTL_CHOICES_SECONDS,
  type BoatRow,
  boatRows,
} from "@t3tools/client-runtime/boat";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type BoatMachineSize,
  BoatRequestId,
  type BoatServer,
  type BoatSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  boatCreateJournal,
  selectBoatCreateController,
  sendBoatRequest,
} from "./boatPendingRequests";

// Keyed by a JSON array of the environments that advertise Boat, read as one list.
const boatSnapshotsAcross = Atom.family((environmentIdsKey: string) => {
  const sources = (JSON.parse(environmentIdsKey) as EnvironmentId[]).map((environmentId) =>
    serverEnvironment.boatLive({ environmentId, input: {} }),
  );
  return Atom.make((get) => sources.map((atom) => get(atom)));
});

const newRequestId = () => BoatRequestId.make(uuidv4());

export function useBoatControllers() {
  const { environments } = useEnvironments();
  const controllers = environments.filter(
    (environment) => environment.serverConfig?.boatEnvironments === true,
  );
  const results = useAtomValue(
    boatSnapshotsAcross(JSON.stringify(controllers.map((entry) => entry.environmentId))),
  );
  const manageable = useEnvironmentsWithScope(controllers, AuthEnvironmentMaintainScope);
  return {
    environments,
    manageable,
    controllers: controllers.flatMap((environment, index) => {
      const result = results[index];
      // A dropped stream keeps its last snapshot; the row is marked stale.
      const snapshot = result === undefined ? Option.none() : AsyncResult.value(result);
      return Option.isSome(snapshot)
        ? [
            {
              environment,
              snapshot: snapshot.value,
              connected: environment.connection.phase === "connected",
            },
          ]
        : [];
    }),
  };
}

function useBoatLabels() {
  const gt = useGT();
  const lifecycle: Record<BoatServer["lifecycle"], string> = {
    provisioning: gt("Starting"),
    running: gt("Running"),
    stopping: gt("Stopping"),
    stopped: gt("Stopped"),
    failed: gt("Needs attention"),
    deleting: gt("Deleting"),
  };
  const failure: Record<NonNullable<NonNullable<BoatServer["operation"]>["failure"]>, string> = {
    unauthorized: gt("Boat rejected the API key."),
    "quota-exceeded": gt("Boat refused: plan limit or billing."),
    "provider-unavailable": gt("Boat did not answer. Try again."),
    "provider-rejected": gt("Boat rejected the request."),
    "bootstrap-failed": gt("T3 Code could not start on the machine."),
    "snapshot-expired": gt("The saved disk has expired."),
    "not-found": gt(
      "Boat could not locate this machine. Check the configured key’s access in Boat.",
    ),
    "unresolved-create": gt("Could not tell which machine Boat made. Check the Boat dashboard."),
    "machine-running": gt("Boat reports it running again. Stop it before deleting."),
    "bootstrap-unavailable": gt("This server cannot set up T3 Code on a Boat machine yet."),
  };
  const action: Record<BoatAction, string> = {
    forget: gt("Forget record"),
    stop: gt("Stop"),
    resume: gt("Resume"),
    delete: gt("Delete"),
  };
  return { lifecycle, failure, action };
}

const TONE_CLASS = {
  neutral: "bg-foreground-muted",
  progress: "bg-primary",
  success: "bg-adaptive-emerald-600-400",
  warning: "bg-warning-foreground",
  danger: "bg-danger-foreground",
} as const;

function BoatMachineRow({
  row,
  nowMs,
  onOpenEnvironment,
}: {
  readonly row: BoatRow;
  readonly nowMs: number;
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const gt = useGT();
  const labels = useBoatLabels();
  const [busy, setBusy] = useState(false);
  const forget = useAtomCommand(serverEnvironment.forgetBoat, { label: "boat forget" });
  const { server } = row;
  const minutesLeft =
    server.autoStopAt === null || server.lifecycle !== "running"
      ? null
      : Math.max(0, Math.round((Date.parse(server.autoStopAt) - nowMs) / 60_000));
  const details = [
    server.size === "small" ? gt("Small") : gt("Default"),
    minutesLeft === null ? null : gt("Stops in {minutes} min", { minutes: minutesLeft }),
    row.cost === null ? null : `$${row.cost.usd.toFixed(row.cost.usd < 0.01 ? 4 : 2)}`,
    server.retention === "expired" ? gt("Disk expired") : null,
    server.lifecycle === "failed" && server.observedPower === "running"
      ? gt("Boat reports it running")
      : null,
    row.stale ? gt("Controller offline") : null,
  ].filter((part): part is string => part !== null);
  const failure =
    server.operation?.stage === "failed" && server.operation.failure != null
      ? labels.failure[server.operation.failure]
      : null;

  const run = async (action: BoatAction) => {
    setBusy(true);
    if (action === "forget") {
      const result = await forget({
        environmentId: row.controllerEnvironmentId,
        input: { managedId: server.managedId, confirmed: true },
      });
      setBusy(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        Dialog.alert(
          gt("Could not update {name}", { name: server.displayName }),
          String(squashAtomCommandFailure(result)),
        );
      }
      return;
    }
    const outcome = await sendBoatRequest({
      kind: action,
      environmentId: row.controllerEnvironmentId,
      input: { requestId: newRequestId(), managedId: server.managedId },
    });
    setBusy(false);
    if (!outcome.ok && outcome.error !== null) {
      Dialog.alert(gt("Could not update {name}", { name: server.displayName }), outcome.error);
    }
  };
  const confirmThen = (action: BoatAction) => {
    if (action === "resume") return void run(action);
    if (action === "forget") {
      Dialog.confirm({
        title: labels.action.forget,
        message: gt(
          "Forget {name} from T3 Code? Confirm it has been deleted in Boat. Forgetting its record does not stop billing.",
          { name: server.displayName },
        ),
        confirmText: labels.action.forget,
        destructive: true,
        onConfirm: () => void run("forget"),
      });
      return;
    }
    Dialog.confirm(
      action === "stop"
        ? {
            title: gt("Stop {name}?", { name: server.displayName }),
            message: gt(
              "Running agents and terminals on it are interrupted. Its files and threads stay on the saved disk.",
            ),
            confirmText: labels.action.stop,
            onConfirm: () => void run("stop"),
          }
        : {
            title: gt("Permanently delete {name}?", { name: server.displayName }),
            message: gt(
              "Its workspace, threads and files on Boat are purged. This cannot be undone.",
            ),
            confirmText: labels.action.delete,
            destructive: true,
            onConfirm: () => void run("delete"),
          },
    );
  };
  const actions = (["resume", "stop", "delete", "forget"] as const).filter((action) =>
    row.actions.has(action),
  );
  const guestId = row.paired ? server.guestEnvironmentId : null;
  const disabled = (actions.length === 0 && guestId === null) || busy;
  const openActions = () =>
    Dialog.alert(server.displayName, labels.lifecycle[server.lifecycle], [
      ...actions.map((action) => ({
        text: labels.action[action],
        style:
          action === "delete" || action === "forget"
            ? ("destructive" as const)
            : ("default" as const),
        onPress: () => confirmThen(action),
      })),
      ...(guestId === null
        ? []
        : [
            {
              text: gt("Manage {environment}", { environment: server.displayName }),
              onPress: () => onOpenEnvironment(guestId),
            },
          ]),
      { text: gt("Cancel"), style: "cancel" as const },
    ]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{name}, {state}", {
        name: server.displayName,
        state: labels.lifecycle[server.lifecycle],
      })}
      accessibilityHint={actions.length > 0 ? gt("Shows machine actions") : undefined}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={openActions}
      className="min-h-14 flex-row items-center gap-3 p-4"
    >
      <View className={cn("size-1.5 rounded-full", TONE_CLASS[row.tone])} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
          {server.displayName}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {labels.lifecycle[server.lifecycle]}
          {details.length > 0 ? ` · ${details.join(" · ")}` : ""}
        </Text>
        {failure ? <Text className="text-sm text-danger-foreground">{failure}</Text> : null}
      </View>
    </Pressable>
  );
}

function BoatKeyRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly snapshot: BoatSnapshot;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  const [boatEnvironment, setBoatEnvironment] = useState(props.snapshot.account.environment ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const setKey = useAtomCommand(serverEnvironment.setBoatApiKey, {
    label: "boat set api key",
    reportFailure: false,
  });
  const { account } = props.snapshot;
  const prepared = useAtomValue(
    environmentSession.preparedConnectionValueAtom(props.environmentId),
  );
  const privateRoute = boatKeyRouteIsPrivate(Option.getOrNull(prepared)?.socketUrl ?? null);
  const showForm = props.canManage && (editing || account.status !== "configured");
  const canReplace = props.canManage && !showForm;
  const canRemove =
    props.canManage &&
    !editing &&
    account.status !== "missing" &&
    props.snapshot.servers.length === 0;
  const save = async (apiKey: string | null) => {
    if (saving || apiKey === "") return;
    setDraft("");
    if (apiKey !== null) {
      // The route may have changed since the field rendered.
      const route = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(props.environmentId),
      );
      if (!boatKeyRouteIsPrivate(Option.getOrNull(route)?.socketUrl ?? null)) {
        Dialog.alert(
          gt(
            "This connection is plain HTTP over the network. Enter the key over HTTPS, T3 Connect, or on that machine.",
          ),
        );
        return;
      }
    }
    setSaving(true);
    const result = await setKey({
      environmentId: props.environmentId,
      input: apiKey === null ? { apiKey } : { apiKey, environment: boatEnvironment.trim() || null },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        Dialog.alert(
          apiKey === null ? gt("Could not remove the Boat key") : gt("Could not save the Boat key"),
          String(squashAtomCommandFailure(result)),
        );
      }
    } else if (result.value.status === "invalid") {
      Dialog.alert(gt("Boat did not accept that key"));
    } else {
      if (apiKey === null) setBoatEnvironment("");
      setEditing(false);
    }
  };
  return (
    <View className="gap-2 p-4">
      <Text className="text-base font-t3-bold text-foreground">
        {gt("Boat account on {environment}", { environment: props.label })}
      </Text>
      <Text className="text-sm text-foreground-muted">
        {account.status === "configured"
          ? gt("Using {account}", { account: account.label ?? "Boat" })
          : account.status === "invalid"
            ? gt("Boat rejected the saved key. Enter a new one.")
            : gt("Add a scoped Boat API key to create machines from this server.")}
      </Text>
      {showForm && !privateRoute ? (
        <Text className="text-sm text-foreground-muted">
          {gt(
            "This connection is plain HTTP over the network. Enter the key over HTTPS, T3 Connect, or on that machine.",
          )}
        </Text>
      ) : showForm ? (
        <>
          <AppTextInput
            accessibilityLabel={gt("Boat environment (optional)")}
            placeholder={gt("Boat environment (optional)")}
            maxLength={120}
            autoCapitalize="none"
            autoCorrect={false}
            value={boatEnvironment}
            editable={!saving}
            onChangeText={setBoatEnvironment}
          />
          <SecretTextInput
            accessibilityLabel={gt("Boat API key")}
            placeholder="boat_…"
            value={draft}
            editable={!saving}
            onChangeText={setDraft}
            onSubmitEditing={(value) => void save(value.trim())}
          />
        </>
      ) : null}
      {(props.canManage && editing) || canReplace || canRemove ? (
        <View className="flex-row flex-wrap gap-2">
          {editing ? (
            <Button
              label={gt("Cancel")}
              tone="text"
              disabled={saving}
              onPress={() => {
                setDraft("");
                setEditing(false);
              }}
            />
          ) : canReplace ? (
            <Button
              label={gt("Replace key")}
              disabled={saving}
              onPress={() => {
                setBoatEnvironment(account.environment ?? "");
                setEditing(true);
              }}
            />
          ) : null}
          {canRemove ? (
            <Button
              label={gt("Remove key")}
              tone="text"
              disabled={saving}
              onPress={() =>
                Dialog.confirm({
                  title: gt("Remove the stored Boat key?"),
                  confirmText: gt("Remove key"),
                  destructive: true,
                  onConfirm: () => void save(null),
                })
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Boat machines from every paired controller that manages them, for both environment lists. */
export function BoatMachinesSection({
  boat: { controllers, manageable, environments },
  onOpenEnvironment,
}: {
  readonly boat: ReturnType<typeof useBoatControllers>;
  readonly onOpenEnvironment: (environmentId: EnvironmentId) => void;
}) {
  const gt = useGT();
  const nowMs = useNowMinuteMs();
  if (controllers.length === 0) return null;
  const rows = boatRows({
    controllers: controllers.map((entry) => ({
      environmentId: entry.environment.environmentId,
      snapshot: entry.snapshot,
      connected: entry.connected,
    })),
    pairedEnvironmentIds: new Set(environments.map((entry) => entry.environmentId)),
    canManage: (environmentId) => manageable.has(environmentId),
    nowMs,
  });
  return (
    <View className="mt-5">
      <SettingsSection title={gt("Boat machines")}>
        {controllers.map(({ environment, snapshot }) => (
          <BoatKeyRow
            key={`key:${environment.environmentId}`}
            environmentId={environment.environmentId}
            label={environment.label}
            snapshot={snapshot}
            canManage={manageable.has(environment.environmentId)}
          />
        ))}
        {rows.map((row) => (
          <BoatMachineRow
            key={row.key}
            row={row}
            nowMs={nowMs}
            onOpenEnvironment={onOpenEnvironment}
          />
        ))}
      </SettingsSection>
    </View>
  );
}

/** Create a Boat machine on a configured controller, from the shared add screen. */
export function BoatCreateSection(props: { readonly onCreated: () => void }) {
  const gt = useGT();
  const { controllers, manageable } = useBoatControllers();
  const owners = controllers.filter(
    (entry) => entry.connected && manageable.has(entry.environment.environmentId),
  );
  const eligible = owners.filter(
    (entry) =>
      entry.snapshot.account.status === "configured" && entry.snapshot.createAvailable !== false,
  );
  const [controllerId, setControllerId] = useState<EnvironmentId | null>(null);
  const [draftName, setName] = useState("");
  const [draftSize, setSize] = useState<BoatMachineSize>("small");
  const [draftTtl, setTtlSeconds] = useState<number>(BOAT_TTL_CHOICES_SECONDS[0]);
  const { entries, busy: creating } = useSyncExternalStore(
    boatCreateJournal.subscribe,
    boatCreateJournal.getSnapshot,
  );
  const pending = entries?.[0] ?? null;
  const name = pending?.input.displayName ?? draftName;
  const size = pending?.input.size ?? draftSize;
  const ttlSeconds = pending?.input.ttlSeconds ?? draftTtl;
  const selectable = pending === null ? eligible : owners;
  const controller = selectBoatCreateController(selectable, controllerId, pending);
  if (controller === undefined && pending !== null) {
    return (
      <Text className="px-4 text-sm text-foreground-muted">
        {gt("Reconnect to the environment and try again.")}
      </Text>
    );
  }
  if (controller === undefined) return null;
  const rate = controller.snapshot.rates.find((entry) => entry.size === size);
  const locked = creating || pending !== null;
  const submit = async () => {
    const request = pending ?? {
      kind: "create" as const,
      environmentId: controller.environment.environmentId,
      input: { requestId: newRequestId(), displayName: name.trim(), size, ttlSeconds },
    };
    const outcome = await sendBoatRequest(request, pending !== null);
    if (outcome === undefined) return;
    if (!outcome.ok) {
      if (outcome.error !== null) {
        Dialog.alert(gt("Could not create the Boat machine"), outcome.error);
      }
      return;
    }
    setName("");
    props.onCreated();
  };
  return (
    <View collapsable={false} className="gap-2">
      <Text className="px-4 text-sm font-t3-medium text-foreground-muted">
        {gt("Or create a Boat machine on {environment}", {
          environment: controller.environment.label,
        })}
      </Text>
      <View className="gap-3 rounded-[26px] border-continuous bg-grouped-card p-4">
        <View
          pointerEvents={locked ? "none" : "auto"}
          className={cn("gap-3", locked && "opacity-60")}
        >
          {selectable.length > 1 ? (
            <SegmentedControl
              options={selectable.map((entry) => ({
                value: entry.environment.environmentId,
                label: entry.environment.label,
                accessibilityLabel: gt("Create on {environment}", {
                  environment: entry.environment.label,
                }),
              }))}
              selected={controller.environment.environmentId}
              onSelect={setControllerId}
            />
          ) : null}
          <AppTextInput
            accessibilityLabel={gt("Machine name")}
            placeholder={gt("Scratch machine")}
            maxLength={64}
            value={name}
            editable={!locked}
            onChangeText={setName}
          />
          <SegmentedControl
            options={[
              { value: "small", label: gt("Small") },
              { value: "default", label: gt("Default") },
            ]}
            selected={size}
            onSelect={setSize}
          />
          <SegmentedControl
            options={BOAT_TTL_CHOICES_SECONDS.map((seconds) => ({
              value: seconds,
              label: gt("{hours} h", { hours: seconds / 3600 }),
              accessibilityLabel: gt("Stops after {hours} hours", { hours: seconds / 3600 }),
            }))}
            selected={ttlSeconds}
            onSelect={setTtlSeconds}
          />
        </View>
        {rate ? (
          <Text className="text-sm leading-normal text-foreground-muted">
            {gt(
              "{rate}/hour list price, billed by Boat to {account}. Boat stops it {hours} h after each start; stopping interrupts running work and keeps the disk.",
              {
                rate: `$${rate.usdPerHour.toFixed(3)}`,
                account: controller.snapshot.account.label ?? "Boat",
                hours: ttlSeconds / 3600,
              },
            )}
          </Text>
        ) : null}
        <Button
          label={gt("Create machine")}
          tone="primary"
          loading={creating}
          disabled={creating || name.trim() === ""}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
