import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { isValidBotName } from "@t3tools/client-runtime/state/bots";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { Bot } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenuItem, AppBarProps } from "../../components/ui/AppBar.types";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListActions } from "../home/useThreadListActions";

export function BotChatHeader(props: {
  readonly bot: Bot;
  readonly subtitle?: string;
  readonly thread: EnvironmentThreadShell;
  readonly archived: boolean;
  readonly canOperate: boolean;
  readonly workspaceItems: ReadonlyArray<AppBarMenuItem>;
  readonly bar: Pick<AppBarProps, "onBackToList" | "backInSplitView">;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const { bot, thread } = props;
  const { environmentId } = thread;
  const { pinThread, unpinThread } = useThreadListActions();
  const update = useAtomCommand(serverEnvironment.updateBot, { reportFailure: false });
  const archive = useAtomCommand(serverEnvironment.archiveBot, { reportFailure: false });
  const canRename = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const canArchive = useAtomValue(serverEnvironment.archiveBot.permissionAtom(environmentId));
  const pinned = thread.pinnedAt !== null;

  const rename = () =>
    Dialog.prompt({
      title: gt("Rename bot"),
      initialValue: bot.name,
      confirmText: gt("Rename", { $context: "verb, confirms renaming a thread" }),
      onConfirm: async (value) => {
        const name = value.trim();
        if (name === bot.name) return;
        if (!isValidBotName(name)) {
          Dialog.alert(
            gt("Could not rename bot"),
            gt("Use letters, numbers, dots, dashes or underscores. No spaces."),
          );
          return;
        }
        const result = await update({ environmentId, input: { botId: bot.id, name } });
        if (AsyncResult.isFailure(result)) {
          const cause = squashAtomCommandFailure(result);
          Dialog.alert(
            gt("Could not rename bot"),
            cause instanceof Error ? cause.message : undefined,
          );
        }
      },
    });

  return (
    <AppBar
      {...props.bar}
      title={bot.name}
      subtitle={props.subtitle ?? bot.title}
      hideBottomBorder
      menus={
        props.archived
          ? undefined
          : [
              {
                title: gt("Bot actions"),
                icon: "ellipsis",
                items: [
                  {
                    id: "rename",
                    title: gt("Rename", { $context: "verb, confirms renaming a thread" }),
                    icon: "square.and.pencil",
                    disabled: !canRename,
                    onPress: rename,
                  },
                  {
                    id: "settings",
                    title: gt("Settings"),
                    icon: "gearshape",
                    onPress: () =>
                      navigation.navigate("BotOverview", { environmentId, botId: bot.id }),
                  },
                  {
                    id: "pin",
                    title: pinned
                      ? gt("Unpin", { $context: "verb, thread action" })
                      : gt("Pin", { $context: "verb, thread action" }),
                    icon: pinned ? "pin.slash" : "pin",
                    disabled: !props.canOperate,
                    onPress: () => void (pinned ? unpinThread : pinThread)(thread),
                  },
                  ...(props.workspaceItems.length
                    ? [
                        {
                          id: "workspace",
                          title: gt("Workspace"),
                          icon: "folder",
                          items: props.workspaceItems,
                        },
                      ]
                    : []),
                  {
                    id: "archive",
                    title: gt("Archive", { $context: "verb, archives a thread" }),
                    icon: "archivebox",
                    disabled: !canArchive,
                    onPress: async () => {
                      const result = await archive({ environmentId, input: { botId: bot.id } });
                      if (AsyncResult.isFailure(result)) {
                        const cause = squashAtomCommandFailure(result);
                        Dialog.alert(
                          gt("Could not archive bot"),
                          cause instanceof Error ? cause.message : undefined,
                        );
                      }
                    },
                  },
                ],
              },
            ]
      }
    />
  );
}
