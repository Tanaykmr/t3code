import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { Keyboard } from "react-native";

import { AppBar } from "../../../components/ui/AppBar";
import { useHardwareBack } from "../../../lib/backHandler";
import { useBotEnvironmentIds, useEnvironmentBots } from "../../../state/bots";
import { serverEnvironment } from "../../../state/server";
import { BotsScreen } from "../../bots/BotsScreen";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

export function AndroidBotsPane() {
  const gt = useGT();
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs()!;
  const environmentId = useBotEnvironmentIds()[0];
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId ?? null));
  const tab = workspace.state.tabs.bots;
  const searching = tab.searchMode !== "resting";
  const showActions = useEnvironmentBots().length > 0 || searching;
  const openSearch = () => {
    if (!showActions || !workspace.isTabActive("bots")) return false;
    workspace.dispatch({ type: "search", tab: "bots" });
    return true;
  };
  const closeSearch = () => {
    Keyboard.dismiss();
    workspace.cancelSearch("bots");
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);
  useHardwareBack(searching && workspace.isTabActive("bots"), () => {
    const state = navigation.getState();
    if (state?.routes[state.index]?.name !== "Home") return false;
    if (Keyboard.isVisible()) Keyboard.dismiss();
    else closeSearch();
    return true;
  });

  return (
    <>
      <AppBar
        embedded
        title={gt("Bots")}
        hideBottomBorder
        actions={
          showActions && canCreate && environmentId !== undefined
            ? [
                {
                  accessibilityLabel: gt("New bot"),
                  icon: "plus",
                  onPress: () => navigation.navigate("BotEditor", { environmentId }),
                },
              ]
            : undefined
        }
        search={
          showActions
            ? {
                value: tab.query,
                onChangeText: (query) => workspace.dispatch({ type: "query", tab: "bots", query }),
                placeholder: gt("Search bots"),
                active: searching,
                onOpen: openSearch,
                onClose: closeSearch,
              }
            : undefined
        }
      />
      <BotsScreen />
    </>
  );
}
