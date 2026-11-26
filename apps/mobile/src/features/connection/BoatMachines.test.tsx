import { RegistryProvider } from "@effect/atom-react";
import { BoatManagedId, BoatRequestId, type BoatSnapshot, EnvironmentId } from "@t3tools/contracts";
import { createBoatCreateJournal, type SavedBoatCreate } from "@t3tools/client-runtime/boat";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { setKey, confirm } = vi.hoisted(() => ({
  setKey: vi.fn(),
  confirm: vi.fn<(request: { message?: string; onConfirm: () => void }) => void>(({ onConfirm }) =>
    onConfirm(),
  ),
}));

vi.mock("react-native", () => ({
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, numberOfLines }: { children: ReactNode; numberOfLines?: number }) => (
    <span data-number-of-lines={numberOfLines}>{children}</span>
  ),
  AppTextInput: ({ value }: { value: string }) => <input readOnly value={value} />,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  confirm,
}));
vi.mock("../../components/ui/SecretTextInput", () => ({
  SecretTextInput: ({ onSubmitEditing }: { onSubmitEditing: (value: string) => void }) => (
    <input
      aria-label="Boat API key"
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmitEditing(event.currentTarget.value);
      }}
    />
  ),
}));
vi.mock("../../components/ui/SegmentedControl", () => ({}));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../../lib/uuid", () => ({}));
vi.mock("./boatPendingRequests", () => ({
  get boatCreateJournal() {
    return journal;
  },
  selectBoatCreateController: () => undefined,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => privateRoute },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId,
        label: "Controller",
        serverConfig: { boatEnvironments: true },
        connection: { phase: "connected" },
      },
    ],
  }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => routeAtom },
  useEnvironmentsWithScope: () => new Set([environmentId]),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { boatLive: () => snapshotAtom },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => setKey }));

import { BoatCreateSection, BoatMachinesSection, useBoatControllers } from "./BoatMachines";

let saved: ReadonlyArray<SavedBoatCreate> = [];
const journal = createBoatCreateJournal(
  async (change) => (saved = change(saved)),
  () => "Storage error",
  () => 0,
);

const environmentId = EnvironmentId.make("controller");
const privateRoute = Option.some({ socketUrl: "wss://controller.example/ws" });
const routeAtom = Atom.make(privateRoute);
const snapshotAtom = Atom.make(
  AsyncResult.success<BoatSnapshot>({
    account: { status: "configured", label: "Boat", environment: "existing" },
    rates: [],
    servers: [],
  }),
);

function BoatSettings({ controllerSnapshot }: { readonly controllerSnapshot?: BoatSnapshot }) {
  const boat = useBoatControllers();
  return (
    <BoatMachinesSection
      boat={
        controllerSnapshot === undefined
          ? boat
          : {
              ...boat,
              controllers: boat.controllers.map((entry) => ({
                ...entry,
                snapshot: controllerSnapshot,
              })),
            }
      }
      onOpenEnvironment={() => {}}
    />
  );
}

it.each([false, true])("warns about automatic stop when providerStale is %s", (providerStale) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement("div");
  const root = createRoot(element);
  const controllerSnapshot: BoatSnapshot = {
    account: { status: "configured", label: "Boat" },
    rates: [],
    providerStale,
    servers: [
      {
        managedId: BoatManagedId.make("boat_machine"),
        displayName: "Test machine",
        size: "small",
        ttlSeconds: 3600,
        lifecycle: "running",
        operation: null,
        sandboxId: "bx_22222222",
        guestEnvironmentId: null,
        origin: null,
        observedPower: "running",
        observedAt: null,
        autoStopAt: "1970-01-01T00:30:00.000Z",
        retention: "unknown",
        usage: null,
        createdAt: "1970-01-01T00:00:00.000Z",
        lastStartedAt: null,
        lastStoppedAt: null,
      },
    ],
  };
  try {
    act(() =>
      root.render(
        <RegistryProvider>
          <BoatSettings controllerSnapshot={controllerSnapshot} />
        </RegistryProvider>,
      ),
    );
    const warning = Array.from(element.querySelectorAll("span")).find(
      (node) => node.textContent === "Boat data is stale. Showing last known state.",
    );
    if (providerStale) {
      expect(warning?.getAttribute("data-number-of-lines")).toBeNull();
      expect(element.textContent).not.toContain("Stops in");
    } else {
      expect(element.textContent).toContain("Stops in 30 min");
    }
    const retentionWarning = Array.from(element.querySelectorAll("span")).find((node) =>
      node.textContent?.includes("Boat may discard the workspace at automatic stop"),
    );
    expect(retentionWarning?.getAttribute("data-number-of-lines")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("requires confirmation to discard a create for the removed controller", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  confirm.mockImplementationOnce(() => {});
  await journal.submit(
    {
      kind: "create",
      environmentId: EnvironmentId.make("removed-controller"),
      input: {
        requestId: BoatRequestId.make("00000000-0000-4000-8000-000000000011"),
        displayName: "Scratch",
        size: "small",
        ttlSeconds: 3600,
      },
    },
    false,
    async () => ({ ok: false, error: null, answered: false }),
  );
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <RegistryProvider>
          <BoatCreateSection onCreated={() => {}} />
        </RegistryProvider>,
      ),
    );
    act(() => element.querySelector("button")!.click());
    const prompt = confirm.mock.lastCall?.[0];
    expect(prompt?.message).toContain("may already exist and incur charges");
    expect(saved).toHaveLength(1);

    await act(async () => prompt?.onConfirm());
    expect(saved).toEqual([]);
    expect(element.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("replaces a configured key and can remove it once no machines remain", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setKey
    .mockReset()
    .mockResolvedValueOnce(AsyncResult.success({ status: "configured" }))
    .mockResolvedValueOnce(AsyncResult.success({ status: "missing" }));
  const element = document.createElement("div");
  const root = createRoot(element);
  try {
    act(() =>
      root.render(
        <RegistryProvider>
          <BoatSettings />
        </RegistryProvider>,
      ),
    );
    const button = (label: string) =>
      Array.from(element.querySelectorAll("button")).find((node) => node.textContent === label);
    expect(button("Replace key")).toBeDefined();
    act(() => button("Replace key")!.click());

    const apiKeyInput = element.querySelector<HTMLInputElement>(
      'input[aria-label="Boat API key"]',
    )!;
    const syntheticInput = "test-only input";
    apiKeyInput.value = syntheticInput;
    await act(async () => {
      apiKeyInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(setKey).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { apiKey: syntheticInput, environment: "existing" },
    });
    expect(element.contains(apiKeyInput)).toBe(false);

    expect(button("Remove key")).toBeDefined();
    await act(async () => button("Remove key")!.click());
    expect(setKey).toHaveBeenNthCalledWith(2, { environmentId, input: { apiKey: null } });
  } finally {
    act(() => root.unmount());
  }
});
