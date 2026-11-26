import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { Bot } from "@t3tools/contracts";
import { BotChatHeader } from "../bots/BotChatHeader";
import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly botChat?: {
    readonly bot: Bot;
    readonly thread: EnvironmentThreadShell;
    readonly archived: boolean;
    readonly canOperate: boolean;
  };
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const fileAction: AppBarAction | null = props.hasThreadCwd
    ? {
        accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
        icon: "folder",
        selected: filesVisible,
        disabled: !props.gitControls.canOpenFiles,
        separateBackground: false,
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      }
    : null;
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  const backInSplitView = props.onReturnToThread
    ? {
        accessibilityLabel: gt("Return to chat"),
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      }
    : undefined;
  if (props.botChat) {
    const workspaceItems = [
      ...(terminalMenu
        ? [
            {
              id: "terminal",
              title: terminalMenu.title,
              icon: "terminal",
              items: terminalMenu.items,
            },
          ]
        : []),
      ...(fileAction
        ? [{ id: "files", title: fileAction.accessibilityLabel, ...fileAction, icon: "folder" }]
        : []),
      ...(gitMenu
        ? [
            {
              id: "git",
              ...gitMenu,
              title: gt("Branch"),
              icon: "point.topleft.down.curvedto.point.bottomright.up",
            },
          ]
        : []),
    ];
    return (
      <BotChatHeader
        {...props.botChat}
        subtitle={props.subtitle}
        bar={{ onBackToList: goBack, backInSplitView }}
        workspaceItems={workspaceItems}
      />
    );
  }
  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={backInSplitView}
      actions={fileAction ? [fileAction] : undefined}
      menus={menus}
      hideBottomBorder
    />
  );
}
