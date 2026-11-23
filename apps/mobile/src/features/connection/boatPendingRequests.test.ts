import { BoatError, BoatManagedId, BoatRequestId, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  run: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => mocks.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mocks.store.set(key, value),
}));
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    createBoat: "create",
    stopBoat: "stop",
    resumeBoat: "resume",
    deleteBoat: "delete",
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.run,
}));

import { resendPendingBoatRequests, sendBoatRequest } from "./boatPendingRequests";

const CONTROLLER = EnvironmentId.make("env-controller");
const request = {
  kind: "create" as const,
  environmentId: CONTROLLER,
  input: {
    requestId: BoatRequestId.make("00000000-0000-4000-8000-000000000001"),
    displayName: "Scratch",
    size: "small" as const,
    ttlSeconds: 3600,
  },
};
const receipt = {
  managedId: BoatManagedId.make("boat_1"),
  requestId: request.input.requestId,
  kind: "create" as const,
};
const saved = () => JSON.parse(mocks.store.get("t3code.boat-pending.v1") ?? "[]");

describe("Boat pending requests", () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.run.mockReset();
  });

  it("keeps a request whose reply was lost and resends it once the controller connects", async () => {
    mocks.run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("socket closed"))));
    expect((await sendBoatRequest(request)).ok).toBe(false);
    expect(saved()).toEqual([request]);

    await resendPendingBoatRequests(new Set());
    expect(mocks.run).toHaveBeenCalledTimes(1);

    mocks.run.mockResolvedValueOnce(AsyncResult.success(receipt));
    await resendPendingBoatRequests(new Set([CONTROLLER]));
    expect(mocks.run).toHaveBeenLastCalledWith({}, "create", request, { reportFailure: false });
    expect(saved()).toEqual([]);
  });

  it("forgets a request the controller rejected", async () => {
    mocks.run.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new BoatError({ code: "conflict", message: "used" }))),
    );
    const outcome = await sendBoatRequest(request);
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("used") });
    expect(saved()).toEqual([]);
  });
});
