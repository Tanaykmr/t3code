import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { serverEnvironment } from "../../state/server";
import { SidebarBotsSection } from "./SidebarBotsSection";

const mocks = vi.hoisted(() => ({
  environmentIds: [] as ReadonlyArray<EnvironmentId>,
  openBotEditor: vi.fn(),
  openBotRoomEditor: vi.fn(),
}));

vi.mock("../../state/bots", () => ({
  useBotEnvironmentIds: () => mocks.environmentIds,
  useEnvironmentBots: () => [],
  useEnvironmentBotRooms: () => [],
}));

vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => null }));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: Atom.make({
      entries: new Map([
        [EnvironmentId.make("local"), { target: { label: "Local" } }],
        [EnvironmentId.make("build"), { target: { label: "Build server" } }],
      ]),
    }),
  },
}));

vi.mock("../../state/server", () => {
  const permissionAtom = Atom.family((_id: EnvironmentId) => Atom.make(false));
  return {
    serverEnvironment: {
      createBot: { permissionAtom },
      createBotRoom: { permissionAtom },
    },
  };
});

vi.mock("./BotEditorDialog", () => ({ openBotEditor: mocks.openBotEditor }));
vi.mock("./BotRoomDialog", () => ({ openBotRoomEditor: mocks.openBotRoomEditor }));

const local = EnvironmentId.make("local");
const build = EnvironmentId.make("build");

function setup(
  environmentIds: ReadonlyArray<EnvironmentId>,
  writable: ReadonlyArray<EnvironmentId>,
) {
  mocks.environmentIds = environmentIds;
  const registry = AtomRegistry.make();
  for (const id of writable) {
    registry.set(serverEnvironment.createBot.permissionAtom(id) as Atom.Writable<boolean>, true);
  }
  mocks.openBotEditor.mockClear();
  mocks.openBotRoomEditor.mockClear();
  return {
    registry,
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it.each([false, true])(
  "routes creation to the selected environment when the first host is writable=%s",
  async (localWritable) => {
    using fixture = setup([local, build], localWritable ? [local, build] : [build]);
    await using screen = await render(
      <RegistryContext.Provider value={fixture.registry}>
        <SidebarBotsSection routeThreadKey={null} />
      </RegistryContext.Provider>,
    );
    for (const [label, openEditor] of [
      ["New bot", mocks.openBotEditor],
      ["New room", mocks.openBotRoomEditor],
    ] as const) {
      await screen.getByRole("button", { name: label }).click();
      const localOption = page.getByRole("menuitem", { name: "Local" });
      if (localWritable) {
        await expect.element(localOption).toBeVisible();
      } else {
        await expect.element(localOption).not.toBeInTheDocument();
      }
      await page.getByRole("menuitem", { name: "Build server" }).click();
      expect(openEditor).toHaveBeenCalledExactlyOnceWith({ mode: "create", environmentId: build });
    }
  },
);

it("opens both editors directly when there is one environment", async () => {
  using fixture = setup([local], [local]);
  await using screen = await render(
    <RegistryContext.Provider value={fixture.registry}>
      <SidebarBotsSection routeThreadKey={null} />
    </RegistryContext.Provider>,
  );
  await screen.getByRole("button", { name: "New bot" }).click();
  await screen.getByRole("button", { name: "New room" }).click();
  expect(mocks.openBotEditor).toHaveBeenCalledExactlyOnceWith({
    mode: "create",
    environmentId: local,
  });
  expect(mocks.openBotRoomEditor).toHaveBeenCalledExactlyOnceWith({
    mode: "create",
    environmentId: local,
  });
});
