import { RegistryContext } from "@effect/atom-react";
import { BotId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { BotComposerSlot } from "./BotRestoreFooter";
import { botChatIsArchived } from "./bot-list";

const { restore } = vi.hoisted(() => ({ restore: vi.fn() }));
const permissions = Atom.family((_id: EnvironmentId) => Atom.make(false));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActivityIndicator: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    restoreBot: { permissionAtom: (id: EnvironmentId) => permissions(id) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => restore }));

it("requires restore permission before restoring the composer in the same chat", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const environmentId = EnvironmentId.make("remote");
  const botId = BotId.make("bolt");
  const archivedAt = "2026-11-23T10:00:00.000Z";
  const container = document.createElement("div");
  const root = createRoot(container);
  const registry = AtomRegistry.make();
  const Chat = ({
    botArchivedAt,
    shellArchivedAt,
  }: {
    botArchivedAt: string | null;
    shellArchivedAt: string | null;
  }) => {
    const [transcript] = useState(() => ({ text: "The changes are covered." }));
    const archived = botChatIsArchived(
      { archivedAt: botArchivedAt },
      { archivedAt: shellArchivedAt },
    );
    return (
      <RegistryContext.Provider value={registry}>
        <p>{transcript.text}</p>
        <BotComposerSlot
          style={{}}
          restore={archived ? { environmentId, botId, enabled: true } : undefined}
        >
          <textarea aria-label="Ask Bolt" />
        </BotComposerSlot>
      </RegistryContext.Provider>
    );
  };

  try {
    restore.mockResolvedValue(AsyncResult.success(undefined));
    act(() => root.render(<Chat botArchivedAt={archivedAt} shellArchivedAt={archivedAt} />));
    const transcript = container.querySelector("p");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("button")?.disabled).toBe(true);
    act(() => container.querySelector("button")?.click());
    expect(restore).not.toHaveBeenCalled();

    act(() => registry.set(permissions(environmentId), true));
    await act(async () => container.querySelector("button")!.click());
    expect(restore).toHaveBeenCalledExactlyOnceWith({
      environmentId: "remote",
      input: { botId: "bolt" },
    });

    act(() => root.render(<Chat botArchivedAt={null} shellArchivedAt={archivedAt} />));
    expect(container.querySelector("textarea")).toBeNull();
    act(() => root.render(<Chat botArchivedAt={null} shellArchivedAt={null} />));
    expect(container.querySelector("p")).toBe(transcript);
    expect(container.querySelector("textarea")?.getAttribute("aria-label")).toBe("Ask Bolt");
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
    registry.dispose();
  }
});
