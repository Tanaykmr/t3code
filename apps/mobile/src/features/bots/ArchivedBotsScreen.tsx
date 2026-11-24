import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { Text } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentBots } from "../../state/bots";
import { startOpeningDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotRow } from "./BotsScreen";
import { botChatParams, partitionBots } from "./bot-list";

export function ArchivedBotsScreen({ route }: StaticScreenProps<{ readonly query?: string }>) {
  const gt = useGT();
  const navigation = useNavigation();
  const bots = useEnvironmentBots();
  const { archived } = partitionBots(bots, route.params?.query);

  return (
    <>
      <AppBar title={gt("Archived bots")} onBack={() => navigation.goBack()} hideBottomBorder />
      <ScreenScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 20 }}
      >
        <Text className="mb-1 text-xs font-semibold text-foreground-muted">
          {gt("{count, plural, one {{count} bot} other {{count} bots}}", {
            count: archived.length,
          })}
        </Text>
        {archived.map(({ environmentId, bot }) => (
          <BotRow
            key={`${environmentId}:${bot.id}`}
            entry={{ environmentId, bot }}
            onOpen={() => {
              const params = botChatParams(bots, environmentId, bot.id);
              if (params === null) return;
              startOpeningDetail({ name: "Thread", params });
              navigation.dispatch(StackActions.push("Thread", params));
            }}
          />
        ))}
      </ScreenScrollView>
    </>
  );
}
