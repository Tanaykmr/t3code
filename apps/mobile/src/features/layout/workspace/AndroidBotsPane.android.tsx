import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { Keyboard } from "react-native";

import { AppBar } from "../../../components/ui/AppBar";
import { useHardwareBack } from "../../../lib/backHandler";
import { useEnvironmentBots } from "../../../state/bots";
import { BotsScreen } from "../../bots/BotsScreen";
import { useBotCreation } from "../../bots/useBotCreation";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

export function AndroidBotsPane() {
  const gt = useGT();
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs()!;
  const createBot = useBotCreation("bot");
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
          showActions && createBot.onPress !== undefined
            ? [
                {
                  accessibilityLabel: createBot.title,
                  icon: "plus",
                  onPress: createBot.onPress,
                },
              ]
            : undefined
        }
        menus={showActions && createBot.menu !== undefined ? [createBot.menu] : undefined}
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
