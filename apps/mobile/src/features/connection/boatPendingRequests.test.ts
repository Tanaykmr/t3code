import { BoatError, BoatManagedId, BoatRequestId, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  failRead: false,
  failWrite: false,
  run: vi.fn(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    if (mocks.failRead) throw new Error("locked");
    return mocks.store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (mocks.failWrite) throw new Error("locked");
    mocks.store.set(key, value);
  },
}));
vi.mock("../../lib/protectedData", () => ({ whenProtectedDataAvailable: async () => {} }));
vi.mock("../../i18n/messages", () => ({ m: (text: string) => text }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
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
const create = {
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
  requestId: create.input.requestId,
  kind: "create" as const,
};
const lost = () => AsyncResult.failure(Cause.fail(new Error("socket closed")));
const saved = () => JSON.parse(mocks.store.get("t3code.boat-pending.v1") ?? "[]");

describe("Boat pending requests", () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.failRead = false;
    mocks.failWrite = false;
    mocks.run.mockReset();
  });

  it("keeps a create whose reply was lost and resends it once its controller connects", async () => {
    mocks.run.mockResolvedValueOnce(lost());
    expect(await sendBoatRequest(create)).toMatchObject({ ok: false, answered: false });
    expect(saved()).toEqual([expect.objectContaining(create)]);

    await resendPendingBoatRequests(new Set());
    expect(mocks.run).toHaveBeenCalledTimes(1);

    mocks.run.mockResolvedValueOnce(AsyncResult.success(receipt));
    await resendPendingBoatRequests(new Set([CONTROLLER]));
    expect(mocks.run).toHaveBeenLastCalledWith({}, "create", create, { reportFailure: false });
    expect(saved()).toEqual([]);
  });

  it("forgets a create the controller rejected", async () => {
    mocks.run.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new BoatError({ code: "conflict", message: "used" }))),
    );
    const outcome = await sendBoatRequest(create);
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("used"), answered: true });
    expect(saved()).toEqual([]);
  });

  it("never saves Stop, Resume or Delete for replay", async () => {
    mocks.run.mockResolvedValueOnce(lost());
    await sendBoatRequest({
      kind: "delete",
      environmentId: CONTROLLER,
      input: { requestId: create.input.requestId, managedId: receipt.managedId },
    });
    expect(saved()).toEqual([]);
  });

  it("drops an older build's saved Delete and undated or expired creates instead of replaying", async () => {
    vi.useFakeTimers({ now: 10 * 3600_000, toFake: ["Date"] });
    mocks.store.set(
      "t3code.boat-pending.v1",
      JSON.stringify([
        { kind: "delete", environmentId: CONTROLLER, input: { requestId: "x", managedId: "m" } },
        create,
        { ...create, savedAt: 0 },
      ]),
    );
    await resendPendingBoatRequests(new Set([CONTROLLER]));
    vi.useRealTimers();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(saved()).toEqual([]);
  });

  it("does not send a create it could not save, and keeps the queue when it cannot read it", async () => {
    mocks.failWrite = true;
    expect((await sendBoatRequest(create)).ok).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();

    mocks.failWrite = false;
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    mocks.store.set("t3code.boat-pending.v1", JSON.stringify([{ ...create, savedAt: 1_000_000 }]));
    mocks.failRead = true;
    await resendPendingBoatRequests(new Set([CONTROLLER]));
    mocks.failRead = false;
    vi.useRealTimers();
    expect(saved()).toHaveLength(1);
  });
});
