import { RegistryProvider } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  type BoatCreateInput,
  BoatManagedId,
  type BoatOperationReceipt,
  type BoatSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

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
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: mocks.environments })) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: (environments) =>
    new Set(environments.map(({ environmentId }) => environmentId)),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const snapshot = Atom.make(
    AsyncResult.success<BoatSnapshot>({
      account: { status: "configured", label: null },
      rates: [],
      servers: [],
    }),
  );
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, boatLive: () => snapshot },
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.create) as never,
}));

import { BoatCreateForm } from "./BoatEnvironmentsSettings";

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
