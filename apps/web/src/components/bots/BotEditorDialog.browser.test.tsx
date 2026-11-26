import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { createContext, use, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { BotEditorDialogHost, openBotEditor } from "./BotEditorDialog";

const environmentId = EnvironmentId.make("local");
const openProject = ProjectId.make("open");
const restrictedProject = ProjectId.make("restricted");
const noAgentProject = ProjectId.make("no-agent");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const { createBot } = vi.hoisted(() => ({ createBot: vi.fn() }));

function provider(
  instanceId: ProviderInstanceId,
  displayName: string,
  model: string,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(instanceId),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
}

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    providerInstances: {},
    projectSettingsOverrides: {
      [restrictedProject]: { providerInstances: { [claude]: { enabled: false } } },
      [noAgentProject]: {
        providerInstances: { [claude]: { enabled: false }, [codex]: { enabled: false } },
      },
    },
  }),
}));
vi.mock("../../state/bots", () => ({ useEnvironmentBots: () => [] }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: openProject, title: "Open project", environmentId },
    { id: restrictedProject, title: "Restricted project", environmentId },
    { id: noAgentProject, title: "No agents", environmentId },
  ],
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () =>
    new Map([
      [environmentId, [provider(codex, "Codex", "gpt-5"), provider(claude, "Claude", "sonnet")]],
    ]),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { createBot, updateBot: vi.fn() } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));

// Exercise the editor's controlled value without the widget's automatic selection repair.
vi.mock("../ui/select", () => {
  type Selection = {
    readonly value: string | null;
    readonly items: Record<string, string>;
    readonly onValueChange: (value: string) => void;
  };
  const SelectionContext = createContext<Selection | null>(null);
  return {
    Select: ({ children, ...selection }: Selection & { readonly children: ReactNode }) => (
      <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>
    ),
    SelectTrigger: ({ id }: { readonly id: string }) => {
      const selection = use(SelectionContext)!;
      return (
        <select
          id={id}
          value={selection.value ?? ""}
          onChange={(event) => selection.onValueChange(event.currentTarget.value)}
        >
          {Object.entries(selection.items).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      );
    },
    SelectItem: () => null,
    SelectPopup: () => null,
    SelectValue: () => null,
  };
});

it("submits an eligible agent after changing the bot's home project", async () => {
  createBot.mockReset();
  createBot.mockResolvedValue(AsyncResult.failure(Cause.fail("Test stop")));
  await using _screen = await render(<BotEditorDialogHost />);
  await act(() => openBotEditor({ mode: "create", environmentId }));
  const editor = page.getByRole("dialog", { name: "New bot" });
  await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Ada");
  const agent = editor.getByRole("combobox", { name: "Agent" });
  await agent.selectOptions(claude);
  await expect.element(agent).toHaveValue(claude);

  const project = editor.getByRole("combobox", { name: "Home project" });
  const submit = editor.getByRole("button", { name: "Create bot" });
  await project.selectOptions(restrictedProject);
  await expect.element(agent).toHaveValue(codex);
  const submitButton = submit.element();
  if (!(submitButton instanceof HTMLButtonElement)) throw new Error("Missing submit button");
  await act(() => submitButton.form?.requestSubmit(submitButton));
  expect(createBot).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      projectId: restrictedProject,
      modelSelection: { instanceId: codex, model: "gpt-5" },
    }),
  });

  await project.selectOptions(noAgentProject);
  await expect.element(submit).toBeDisabled();
});
