import { useAtomValue } from "@effect/atom-react";
import {
  type BoatAction,
  boatKeyRouteIsPrivate,
  boatRequestAnswered,
  BOAT_TTL_CHOICES_SECONDS,
  type BoatRow,
  type BoatTone,
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
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react";
import { PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn, randomUUID } from "../../lib/utils";
import { boatCreateJournal, subscribeBoatCreateJournal } from "../../state/boatCreateJournal";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const boatSnapshotsAtom = environmentAtomList("web-boat-snapshots", (environmentId) =>
  serverEnvironment.boatLive({ environmentId, input: {} }),
);

const TONE_CLASS: Record<BoatTone, string> = {
  neutral: "bg-muted-foreground/60",
  progress: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

const newRequestId = () => BoatRequestId.make(randomUUID());

/** Connected or cached environments whose server can manage Boat machines. */
export function useBoatControllers(environments: ReadonlyArray<EnvironmentPresentation>) {
  const controllers = environments.filter(
    (environment) => environment.serverConfig?.boatEnvironments === true,
  );
  const results = useAtomValue(
    boatSnapshotsAtom(environmentIdsKey(controllers.map((entry) => entry.environmentId))),
  );
  const manageable = useEnvironmentsWithScope(controllers, AuthEnvironmentMaintainScope);
  return {
    environments,
    manageable,
    controllers: controllers.flatMap((environment, index) => {
      const result = results[index];
      // A failed or reconnecting stream keeps its last snapshot, shown as stale.
      const snapshot = result === undefined ? Option.none() : AsyncResult.value(result);
      return Option.isSome(snapshot)
        ? [
            {
              environment,
              snapshot: snapshot.value,
              connected: environment.connection.phase === "connected",
              subscriptionStale: result?._tag === "Failure",
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
  const stage: Record<NonNullable<BoatServer["operation"]>["stage"], string | null> = {
    queued: gt("Queued"),
    allocating: gt("Allocating a machine"),
    bootstrapping: gt("Installing T3 Code"),
    stopping: gt("Waiting for Boat to save the disk"),
    resuming: gt("Waking the machine"),
    deleting: gt("Purging data"),
    completed: null,
    failed: null,
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
    stop: gt("Stop"),
    forget: gt("Forget record"),
    resume: gt("Resume"),
    delete: gt("Delete"),
  };
  return { lifecycle, stage, failure, action };
}

function formatUsd(usd: number) {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

type RenderSavedGuest = (
  environmentId: EnvironmentId,
  content: { readonly label: string; readonly status: ReactNode; readonly actions: ReactNode },
) => ReactNode;

function BoatRowView({
  row,
  nowMs,
  renderSavedGuest,
}: {
  readonly row: BoatRow;
  readonly nowMs: number;
  readonly renderSavedGuest: RenderSavedGuest;
}) {
  const gt = useGT();
  const labels = useBoatLabels();
  const [busy, setBusy] = useState<BoatAction | null>(null);
  const stop = useAtomCommand(serverEnvironment.stopBoat, { label: "boat stop" });
  const resume = useAtomCommand(serverEnvironment.resumeBoat, { label: "boat resume" });
  const remove = useAtomCommand(serverEnvironment.deleteBoat, { label: "boat delete" });
  const forget = useAtomCommand(serverEnvironment.forgetBoat, { label: "boat forget" });
  const { server } = row;
  const operation = server.operation;
  const stage = operation === null ? null : labels.stage[operation.stage];
  // A refused action can leave the machine Stopped; its reason still shows.
  const failure =
    operation?.stage === "failed" && operation.failure ? labels.failure[operation.failure] : null;
  const minutesLeft =
    row.stale || server.autoStopAt === null || server.lifecycle !== "running"
      ? null
      : Math.max(0, Math.round((Date.parse(server.autoStopAt) - nowMs) / 60_000));

  const act = async (action: BoatAction) => {
    if (action === "stop") {
      const message = gt(
        "Stop {name}? Running agents and terminals on it are interrupted. Its files and threads stay on the saved disk.",
        { name: server.displayName },
      );
      if (!((await requestConfirmDialog(message)) ?? window.confirm(message))) return;
    }
    if (action === "delete" || action === "forget") {
      const message =
        action === "forget"
          ? gt(
              "Forget {name} from T3 Code? Confirm it has been deleted in Boat. Forgetting its record does not stop billing.",
              { name: server.displayName },
            )
          : gt(
              "Permanently delete {name}? Its workspace, threads and files on Boat are purged. This cannot be undone.",
              { name: server.displayName },
            );
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(action);
    const environmentId = row.controllerEnvironmentId;
    const managedId = server.managedId;
    const result =
      action === "forget"
        ? await forget({ environmentId, input: { managedId, confirmed: true } })
        : await (action === "stop" ? stop : action === "resume" ? resume : remove)({
            environmentId,
            input: { requestId: newRequestId(), managedId },
          });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not {action} {name}", {
          action: labels.action[action].toLowerCase(),
          name: server.displayName,
        }),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  const details = [
    server.size === "small" ? gt("Small") : gt("Default"),
    minutesLeft === null ? null : gt("Stops in {minutes} min", { minutes: minutesLeft }),
    row.cost === null
      ? null
      : row.cost.source === "usage"
        ? gt("{cost} machine usage", { cost: formatUsd(row.cost.usd) })
        : gt("about {cost} so far", { cost: formatUsd(row.cost.usd) }),
    row.stale
      ? null
      : server.lifecycle === "stopped" && server.retention === "available"
        ? gt("Disk saved")
        : server.retention === "expired"
          ? gt("Disk expired")
          : null,
    !row.stale && server.lifecycle === "failed" && server.observedPower !== null
      ? server.observedPower === "running"
        ? gt("Boat reports it running")
        : server.observedPower === "stopped"
          ? gt("Boat reports it stopped")
          : null
      : null,
    row.paired ? gt("Connected on this device") : null,
    row.staleReason === "controller-offline"
      ? gt("Controller offline; last known state")
      : row.staleReason === "provider"
        ? gt("Boat data is stale. Showing last known state.")
        : null,
  ].filter((part): part is string => part !== null);

  const description = (
    <span className="flex flex-col gap-0.5">
      <span>
        {labels.lifecycle[server.lifecycle]}
        {stage && server.lifecycle !== "running" && server.lifecycle !== "stopped"
          ? ` · ${stage}`
          : ""}
      </span>
      {failure ? <span className="text-destructive-foreground">{failure}</span> : null}
      <span className="text-muted-foreground/80">{details.join(" · ")}</span>
    </span>
  );
  const actions = (["resume", "stop", "delete", "forget"] as const)
    .filter((action) => row.actions.has(action))
    .map((action) => {
      const Icon = action === "stop" ? SquareIcon : action === "resume" ? PlayIcon : Trash2Icon;
      return (
        <Button
          key={action}
          size="xs"
          variant={action === "delete" || action === "forget" ? "ghost-destructive" : "ghost-muted"}
          disabled={busy !== null}
          onClick={() => void act(action)}
        >
          {busy === action ? <Spinner size="sm" /> : <Icon aria-hidden className="size-3" />}
          <span>{labels.action[action]}</span>
        </Button>
      );
    });
  const savedGuest =
    server.guestEnvironmentId === null
      ? null
      : renderSavedGuest(server.guestEnvironmentId, {
          label: server.displayName,
          status: description,
          actions,
        });
  if (savedGuest !== null) return savedGuest;

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[row.tone])}
          />
          <span className="truncate">{server.displayName}</span>
        </span>
      }
      description={description}
      control={<div className="flex items-center gap-1">{actions}</div>}
    />
  );
}

function BoatKeyRow({
  environment,
  snapshot,
  canManage,
}: {
  readonly environment: EnvironmentPresentation;
  readonly snapshot: BoatSnapshot;
  readonly canManage: boolean;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  const [boatEnvironment, setBoatEnvironment] = useState(snapshot.account.environment ?? "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const setKey = useAtomCommand(serverEnvironment.setBoatApiKey, {
    label: "boat set api key",
    reportFailure: false,
  });
  const { account } = snapshot;
  const save = async (apiKey: string | null) => {
    if (saving || apiKey === "") return;
    setDraft("");
    if (apiKey !== null) {
      // The route may have changed since the form rendered.
      const route = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environment.environmentId),
      );
      if (!boatKeyRouteIsPrivate(Option.getOrNull(route)?.socketUrl ?? null)) {
        toastManager.add({
          type: "error",
          title: gt(
            "This connection is plain HTTP over the network. Enter the key over HTTPS, T3 Connect, or on that machine.",
          ),
        });
        return;
      }
    }
    setSaving(true);
    const result = await setKey({
      environmentId: environment.environmentId,
      input: apiKey === null ? { apiKey } : { apiKey, environment: boatEnvironment.trim() || null },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title:
            apiKey === null
              ? gt("Could not remove the Boat key")
              : gt("Could not save the Boat key"),
          description: String(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    if (result.value.status === "invalid") {
      toastManager.add({ type: "error", title: gt("Boat did not accept that key") });
      return;
    }
    if (apiKey === null) setBoatEnvironment("");
    setEditing(false);
  };
  const remove = async () => {
    const message = gt("Remove the stored Boat key?");
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (confirmed) await save(null);
  };
  const status =
    account.status === "configured"
      ? gt("Using {account}", { account: account.label ?? "Boat" })
      : account.status === "invalid"
        ? gt("Boat rejected the saved key. Enter a new one.")
        : gt("Add a scoped Boat API key to create machines from {environment}.", {
            environment: environment.label,
          });
  const showForm = canManage && (editing || account.status !== "configured");
  const canReplace = canManage && !showForm;
  const canRemove =
    canManage && !editing && account.status !== "missing" && snapshot.servers.length === 0;
  const prepared = useAtomValue(
    environmentSession.preparedConnectionValueAtom(environment.environmentId),
  );
  const privateRoute = boatKeyRouteIsPrivate(Option.getOrNull(prepared)?.socketUrl ?? null);
  return (
    <SettingsRow
      title={gt("Boat account on {environment}", { environment: environment.label })}
      description={status}
      control={
        canReplace || canRemove ? (
          <div className="flex flex-wrap justify-end gap-1">
            {canReplace ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={saving}
                onClick={() => {
                  setBoatEnvironment(account.environment ?? "");
                  setEditing(true);
                }}
              >
                {gt("Replace key")}
              </Button>
            ) : null}
            {canRemove ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={saving}
                onClick={() => void remove()}
              >
                {gt("Remove key")}
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {showForm && !privateRoute ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {gt(
            "This connection is plain HTTP over the network. Enter the key over HTTPS, T3 Connect, or on that machine.",
          )}
        </p>
      ) : showForm ? (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft.trim());
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="w-72 max-w-full"
            aria-label={gt("Boat API key")}
            placeholder="boat_…"
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Input
            autoComplete="off"
            spellCheck={false}
            className="w-72 max-w-full"
            aria-label={gt("Boat environment (optional)")}
            placeholder={gt("Boat environment (optional)")}
            maxLength={120}
            value={boatEnvironment}
            disabled={saving}
            onChange={(event) => setBoatEnvironment(event.target.value)}
          />
          <Button size="xs" type="submit" disabled={saving || draft.trim() === ""}>
            {saving ? <Spinner size="sm" /> : null}
            {gt("Save key")}
          </Button>
          {editing ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={saving}
              onClick={() => {
                setDraft("");
                setEditing(false);
              }}
            >
              {gt("Cancel")}
            </Button>
          ) : null}
        </form>
      ) : null}
    </SettingsRow>
  );
}

/** Boat machines this device can see, from every controller that manages them. */
export function BoatEnvironmentsSettings({
  boat: { controllers, manageable, environments },
  renderSavedGuest,
}: {
  readonly boat: ReturnType<typeof useBoatControllers>;
  readonly renderSavedGuest: RenderSavedGuest;
}) {
  const gt = useGT();
  // The tick is a UTC minute without a zone suffix.
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  if (controllers.length === 0) return null;
  const paired = new Set<EnvironmentId>(environments.map((entry) => entry.environmentId));
  const rows = boatRows({
    controllers: controllers.map((entry) => ({
      environmentId: entry.environment.environmentId,
      snapshot: entry.snapshot,
      connected: entry.connected,
      subscriptionStale: entry.subscriptionStale,
    })),
    pairedEnvironmentIds: paired,
    canManage: (environmentId) => manageable.has(environmentId),
    nowMs,
  });
  return (
    <SettingsSection id="boat-environments" title={gt("Boat machines")}>
      {controllers.map(({ environment, snapshot }) => (
        <BoatKeyRow
          key={`key:${environment.environmentId}`}
          environment={environment}
          snapshot={snapshot}
          canManage={manageable.has(environment.environmentId)}
        />
      ))}
      {rows.map((row) => (
        <BoatRowView key={row.key} row={row} nowMs={nowMs} renderSavedGuest={renderSavedGuest} />
      ))}
    </SettingsSection>
  );
}

const BOAT_DEFAULT_TTL_SECONDS = BOAT_TTL_CHOICES_SECONDS[0];

/** The Boat mode of Add environment: name, size and stop deadline, created on a controller. */
export function BoatCreateForm({ onCreated }: { readonly onCreated: () => void }) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const { controllers, manageable } = useBoatControllers(environments);
  const owners = controllers.filter(
    (entry) => entry.connected && manageable.has(entry.environment.environmentId),
  );
  const eligible = owners.filter((entry) => entry.snapshot.account.status === "configured");
  const capable = eligible.filter((entry) => entry.snapshot.createAvailable !== false);
  const [controllerId, setControllerId] = useState<EnvironmentId | null>(null);
  const [draftName, setName] = useState("");
  const [draftSize, setSize] = useState<BoatMachineSize>("small");
  const [draftTtl, setTtlSeconds] = useState<number>(BOAT_DEFAULT_TTL_SECONDS);
  const { entries, busy: creating } = useSyncExternalStore(
    subscribeBoatCreateJournal,
    boatCreateJournal.getSnapshot,
  );
  const pending = entries?.[0];
  const name = pending?.input.displayName ?? draftName;
  const size = pending?.input.size ?? draftSize;
  const ttlSeconds = pending?.input.ttlSeconds ?? draftTtl;
  const create = useAtomCommand(serverEnvironment.createBoat, {
    label: "boat create",
    reportFailure: false,
  });

  const controller = pending
    ? owners.find((entry) => entry.environment.environmentId === pending.environmentId)
    : (capable.find((entry) => entry.environment.environmentId === controllerId) ?? capable[0]);
  if (controller === undefined && pending !== undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {gt("Reconnect to the environment and try again.")}
      </p>
    );
  }
  const blocked = eligible.find((entry) => entry.snapshot.createAvailable === false);
  if (controller === undefined && blocked !== undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {gt(
          "{environment} cannot set up T3 Code on a new Boat machine yet. Update it to a release that can.",
          { environment: blocked.environment.label },
        )}
      </p>
    );
  }
  if (controller === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {controllers.length === 0
          ? gt("None of your connected environments can create Boat machines yet.")
          : gt(
              "Add a Boat API key under Settings → Environments → Boat machines on the server that should own the machine.",
            )}
      </p>
    );
  }
  const rate = controller.snapshot.rates.find((entry) => entry.size === size);
  const submit = async () => {
    const request = pending ?? {
      kind: "create" as const,
      environmentId: controller.environment.environmentId,
      input: { requestId: newRequestId(), displayName: name.trim(), size, ttlSeconds },
    };
    const outcome = await boatCreateJournal.submit(
      request,
      pending !== undefined,
      async (saved) => {
        const result = await create({ environmentId: saved.environmentId, input: saved.input });
        if (result._tag === "Success") return { ok: true, receipt: result.value };
        if (isAtomCommandInterrupted(result)) return { ok: false, error: null, answered: false };
        const error = squashAtomCommandFailure(result);
        return { ok: false, error: String(error), answered: boatRequestAnswered(error) };
      },
    );
    if (outcome === undefined) return;
    if (!outcome.ok) {
      if (outcome.error !== null) {
        toastManager.add({
          type: "error",
          title: gt("Could not create the Boat machine"),
          description: outcome.error,
        });
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Creating {name}", { name: name.trim() }),
      description: gt("Progress shows under Settings → Environments → Boat machines."),
    });
    onCreated();
  };
  const hours = ttlSeconds / 3600;
  const locked = creating || pending !== undefined;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!creating && name.trim() !== "") void submit();
      }}
    >
      {(pending ? owners : capable).length > 1 ? (
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">{gt("Owned by")}</span>
          <select
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={controller.environment.environmentId}
            disabled={locked}
            onChange={(event) => setControllerId(event.target.value as EnvironmentId)}
          >
            {(pending ? owners : capable).map((entry) => (
              <option key={entry.environment.environmentId} value={entry.environment.environmentId}>
                {entry.environment.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_7rem]">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">{gt("Name")}</span>
          <Input
            value={name}
            maxLength={64}
            placeholder={gt("Scratch machine")}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">{gt("Size")}</span>
          <select
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={size}
            disabled={locked}
            onChange={(event) => setSize(event.target.value as BoatMachineSize)}
          >
            <option value="small">{gt("Small · 2 CPU, 4 GB")}</option>
            <option value="default">{gt("Default · 4 CPU, 8 GB")}</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">
            {gt("Stops after")}
          </span>
          <select
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={ttlSeconds}
            disabled={locked}
            onChange={(event) => setTtlSeconds(Number(event.target.value))}
          >
            {BOAT_TTL_CHOICES_SECONDS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {gt("{hours} h", { hours: seconds / 3600 })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {rate
          ? gt(
              "{rate}/hour list price, billed by Boat to {account}. Boat stops it {hours} h after each start; stopping interrupts running work and keeps the disk.",
              {
                rate: `$${rate.usdPerHour.toFixed(3)}`,
                account: controller.snapshot.account.label ?? "Boat",
                hours,
              },
            )
          : null}
      </p>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={creating || name.trim() === ""}>
          {creating ? <Spinner size="sm" /> : null}
          {gt("Create machine")}
        </Button>
      </div>
    </form>
  );
}
