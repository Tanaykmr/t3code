import { RegistryProvider } from "@effect/atom-react";
import { type BoatSnapshot, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const setKey = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({ value }: { value: string }) => <input readOnly value={value} />,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  confirm: ({ onConfirm }: { onConfirm: () => void }) => onConfirm(),
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
vi.mock("./boatPendingRequests", () => ({}));
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

import { BoatMachinesSection, useBoatControllers } from "./BoatMachines";

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

function BoatSettings() {
  const boat = useBoatControllers();
  return <BoatMachinesSection boat={boat} onOpenEnvironment={() => {}} />;
}

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
