import { RegistryProvider } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type BoatCreateInput,
  BoatManagedId,
  type BoatOperationReceipt,
  type BoatSetApiKeyInput,
  type BoatSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useEnvironments } from "../../state/environments";

const mocks = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    label: string;
    serverConfig: { boatEnvironments: true };
    connection: { phase: "connected" | "offline" };
  }>,
  create:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: BoatCreateInput;
      }) => Promise<AtomCommandResult<BoatOperationReceipt, Error>>
    >(),
  setKey: vi.fn(),
  forget: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: mocks.environments })) as never,
}));

vi.mock(import("../../state/session"), async (original) => {
  const actual = await original();
  const unavailableRoute = Atom.make(Option.none());
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      preparedConnectionValueAtom: () => unavailableRoute,
    },
    useEnvironmentsWithScope: (environments) =>
      new Set(environments.map(({ environmentId }) => environmentId)),
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const snapshot = Atom.make(
    AsyncResult.success<BoatSnapshot>({
      account: { status: "configured", label: null },
      rates: [],
      servers: [],
    }),
  );
  const machine = {
    managedId: BoatManagedId.make("old-machine"),
    displayName: "Old machine",
    size: "small",
    ttlSeconds: 3600,
    lifecycle: "stopped",
    operation: null,
    sandboxId: "bx_22222222",
    guestEnvironmentId: null,
    origin: null,
    observedPower: "missing",
    observedAt: null,
    autoStopAt: null,
    retention: "unknown",
    usage: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    lastStartedAt: null,
    lastStoppedAt: null,
  } satisfies BoatSnapshot["servers"][number];
  const recovery = Atom.make(
    AsyncResult.success<BoatSnapshot>({
      account: { status: "invalid", label: "Boat" },
      rates: [],
      forgetAvailable: true,
      servers: [machine],
    }),
  );
  const running: BoatSnapshot = {
    account: { status: "configured", label: "Boat" },
    rates: [{ size: "small", usdPerHour: 0.018, asOf: "2026-11-01T00:00:00.000Z" }],
    servers: [
      {
        ...machine,
        lifecycle: "running",
        observedPower: "running",
        autoStopAt: "2026-11-30T00:00:00.000Z",
      },
    ],
  };
  const live = Atom.make(AsyncResult.success(running));
  const outage = Atom.make(AsyncResult.success({ ...running, providerStale: true }));
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      boatLive: ({ environmentId }: { environmentId: EnvironmentId }) =>
        environmentId === "controller-recovery"
          ? recovery
          : environmentId === "controller-outage"
            ? outage
            : environmentId === "controller-running"
              ? live
              : snapshot,
    },
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: unknown, options: { label: string }) =>
    options.label === "boat forget"
      ? mocks.forget
      : options.label === "boat set api key"
        ? mocks.setKey
        : mocks.create) as never,
}));

import { ConfirmDialogHost } from "../ConfirmDialogHost";
import {
  BoatCreateForm,
  BoatEnvironmentsSettings,
  useBoatControllers,
} from "./BoatEnvironmentsSettings";

function BoatSettings() {
  const { environments } = useEnvironments();
  const boat = useBoatControllers(environments);
  return <BoatEnvironmentsSettings boat={boat} renderSavedGuest={() => null} />;
}

it("marks Boat data stale while the controller is connected", async () => {
  mocks.environments = [
    {
      environmentId: EnvironmentId.make("controller-outage"),
      label: "Owner",
      serverConfig: { boatEnvironments: true },
      connection: { phase: "connected" },
    },
  ];
  await using screen = await render(
    <RegistryProvider>
      <BoatSettings />
    </RegistryProvider>,
  );
  const stop = screen.getByRole("button", { name: "Stop" });
  await expect.element(stop).toBeVisible();
  const details = stop.element().closest('[data-slot="settings-row"]')?.textContent;
  expect(details).toContain("Boat data is stale. Showing last known state.");
  expect(details).not.toMatch(/Stops in \d+ min/);
});

it("warns that automatic stop can discard the workspace before and after creation", async () => {
  mocks.environments = [
    {
      environmentId: EnvironmentId.make("controller-running"),
      label: "Owner",
      serverConfig: { boatEnvironments: true },
      connection: { phase: "connected" },
    },
  ];
  await using screen = await render(
    <RegistryProvider>
      <BoatSettings />
      <BoatCreateForm onCreated={() => {}} />
    </RegistryProvider>,
  );
  const warning =
    "Boat may discard the workspace at automatic stop, depending on its retention settings.";
  const stop = screen.getByRole("button", { name: "Stop", exact: true });
  await expect.element(stop).toBeVisible();
  expect(stop.element().closest('[data-slot="settings-row"]')?.textContent).toContain(warning);
  const billing = screen.getByText(/list price, billed by Boat/);
  await expect.element(billing).toBeVisible();
  expect(billing.element().textContent).toContain(warning);
  expect(billing.element().textContent).not.toContain("keeps the disk");
});

it("requires confirmation before forgetting a Boat record locally", async () => {
  const environmentId = EnvironmentId.make("controller-recovery");
  mocks.environments = [
    {
      environmentId,
      label: "Owner",
      serverConfig: { boatEnvironments: true },
      connection: { phase: "connected" },
    },
  ];
  mocks.forget.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    <RegistryProvider>
      <BoatSettings />
      <ConfirmDialogHost />
    </RegistryProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Forget record" }));
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  expect(dialog.element().textContent).toContain("Forgetting its record does not stop billing.");
  expect(mocks.forget).not.toHaveBeenCalled();
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  await expect.element(confirm).toBeVisible();
  (confirm.element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(mocks.forget).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { managedId: "old-machine", confirmed: true },
    }),
  );
});

it("removes a stored Boat key after confirmation without sending a credential", async () => {
  const environmentId = EnvironmentId.make("controller-with-key");
  mocks.environments = [
    {
      environmentId,
      label: "Owner",
      serverConfig: { boatEnvironments: true },
      connection: { phase: "connected" },
    },
  ];
  mocks.setKey.mockReset().mockResolvedValue(AsyncResult.success({ status: "missing" }));
  await using screen = await render(
    <RegistryProvider>
      <BoatSettings />
      <ConfirmDialogHost />
    </RegistryProvider>,
  );

  const remove = screen.getByRole("button", { name: "Remove key" });
  const dialog = page.getByRole("alertdialog");
  await userEvent.click(remove);
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(mocks.setKey).not.toHaveBeenCalled();

  await userEvent.click(remove);
  const confirm = dialog.getByRole("button", { name: "Confirm" });
  await expect.element(confirm).toBeVisible();
  (confirm.element() as HTMLButtonElement).focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(mocks.setKey).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { apiKey: null } satisfies BoatSetApiKeyInput,
    }),
  );
});

it("retries an unanswered Boat create with the same request ID on its original controller", async () => {
  const owner = EnvironmentId.make("controller-owner");
  const fallback = EnvironmentId.make("controller-fallback");
  const controllers = [owner, fallback].map((environmentId) => ({
    environmentId,
    label: environmentId === owner ? "Owner" : "Fallback",
    serverConfig: { boatEnvironments: true as const },
    connection: { phase: "connected" as const },
  }));
  mocks.environments = controllers;
  mocks.create
    .mockReset()
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Connection lost"))))
    .mockImplementation(async ({ input }) =>
      AsyncResult.success({
        managedId: BoatManagedId.make("managed-machine"),
        requestId: input.requestId,
        kind: "create",
      }),
    );
  const onCreated = vi.fn();
  const form = () => (
    <RegistryProvider>
      <BoatCreateForm onCreated={onCreated} />
    </RegistryProvider>
  );
  await using screen = await render(form());
  const submit = screen.getByRole("button", { name: "Create machine" });
  await userEvent.fill(screen.getByRole("textbox", { name: "Name" }), "Scratch");
  await userEvent.click(submit);
  await expect.element(submit).toBeEnabled();
  expect(mocks.create).toHaveBeenCalledOnce();
  const [request] = mocks.create.mock.calls[0]!;
  expect(request.environmentId).toBe(owner);

  await screen.rerender(<></>);
  mocks.environments = controllers.map((controller) =>
    controller.environmentId === owner
      ? { ...controller, connection: { phase: "offline" } }
      : controller,
  );
  await screen.rerender(form());
  expect(submit.query()).toBeNull();
  expect(mocks.create).toHaveBeenCalledOnce();

  mocks.environments = controllers;
  await screen.rerender(form());
  await userEvent.click(submit);
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create).toHaveBeenLastCalledWith(request);
  await expect.poll(() => onCreated.mock.calls.length).toBe(1);
});
