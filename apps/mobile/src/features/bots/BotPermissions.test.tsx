import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { BotOverviewScreen } from "./BotOverviewScreen";
import { BotsScreen } from "./BotsScreen";

const { state, passthrough, navigate, mutate } = vi.hoisted(() => ({
  state: { canOperate: false, hasBot: true, archivedAt: null as string | null },
  passthrough: ({ children }: { children?: ReactNode }) => children,
  navigate: vi.fn(),
  mutate: vi.fn(),
}));

function entries() {
  return state.hasBot
    ? [
        {
          environmentId: "remote",
          bot: {
            id: "bolt",
            name: "Bolt",
            title: "",
            persona: "",
            projectId: "project",
            allowedProjectIds: [],
            dmThreadId: "dm-bolt",
            archivedAt: state.archivedAt,
          },
        },
      ]
    : [];
}

vi.mock("react-native", () => ({
  Text: passthrough,
  View: passthrough,
  Pressable: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: passthrough }));
vi.mock("../../components/ui/FitSheet", () => ({ FitSheet: passthrough }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: passthrough }));
vi.mock("../../state/bots", () => ({
  useBotEnvironmentIds: () => ["remote"],
  useBotInbox: () => ({ ordered: entries(), pinned: [] }),
  useEnvironmentBots: entries,
  useEnvironmentBotRooms: () => [],
}));
vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useProjects: () => [],
  useQuietThreadShell: () => null,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canOperate }));
vi.mock("../../state/server", () => {
  const permissionAtom = (environmentId: string | null) =>
    environmentId === "remote" && state.canOperate;
  return {
    serverEnvironment: {
      createBot: { permissionAtom },
      createBotRoom: { permissionAtom },
      updateBot: { permissionAtom },
      archiveBot: { permissionAtom },
      restoreBot: { permissionAtom },
      botChannelLive: () => AsyncResult.initial(),
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mutate }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../layout/workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
vi.mock("../threads/useMessageTimeFormatter", () => ({ useMessageTimeFormatter: () => vi.fn() }));
vi.mock("./BotGlyph", () => ({ BotGlyph: () => null }));
vi.mock("./BotKnowledge", () => ({ BotKnowledge: () => null }));
vi.mock("./BotRoutines", () => ({ BotRoutines: () => null }));

it.each([false, true])("gates bot controls when canOperate is %s", (canOperate) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state, { canOperate, hasBot: true, archivedAt: null });
  navigate.mockClear();
  mutate.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
    );
  const overview = () => (
    <BotOverviewScreen route={{ params: { environmentId: "remote", botId: "bolt" } }} />
  );

  try {
    act(() => root.render(<BotsScreen />));
    expect(button("Bolt")?.disabled).toBe(false);
    expect(button("New room")?.disabled === false).toBe(canOperate);
    state.hasBot = false;
    act(() => root.render(<BotsScreen />));
    expect(button("New bot")?.disabled === false).toBe(canOperate);

    state.hasBot = true;
    act(() => root.render(overview()));
    expect(button("Edit Bolt")?.disabled).toBe(!canOperate);
    expect(button("Archive bot")?.disabled).toBe(!canOperate);
    state.archivedAt = "2026-11-23T10:00:00.000Z";
    act(() => root.render(overview()));
    expect(button("Restore bot")?.disabled).toBe(!canOperate);
    if (!canOperate) {
      act(() => {
        button("Edit Bolt")?.click();
        button("Restore bot")?.click();
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
    }
  } finally {
    act(() => root.unmount());
  }
});
