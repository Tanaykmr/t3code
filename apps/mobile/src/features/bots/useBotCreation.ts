import { useAtomValue } from "@effect/atom-react";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react-native";

import { environmentCatalog } from "../../connection/catalog";
import { useBotEnvironmentIds } from "../../state/bots";
import { serverEnvironment } from "../../state/server";

const noEnvironments: ReadonlyArray<EnvironmentId> = [];

const creationTargetsAtom = Atom.family((ids: ReadonlyArray<EnvironmentId>) =>
  Atom.make((get) => {
    if (ids.length === 0) return { bot: [], room: [] };
    const { entries } = get(environmentCatalog.catalogValueAtom);
    const targets = ids.map((id) => {
      const entry = entries.get(id);
      return {
        id,
        title: entry?.target.label ?? id,
        address: entry === undefined ? null : connectionCatalogDisplayUrl(entry),
      };
    });
    return {
      bot: targets.filter(({ id }) => get(serverEnvironment.createBot.permissionAtom(id))),
      room: targets.filter(({ id }) => get(serverEnvironment.createBotRoom.permissionAtom(id))),
    };
  }),
);

export function useBotCreation(
  kind: "bot" | "room",
  eligibleIds?: ReadonlySet<EnvironmentId>,
  enabled = true,
) {
  const gt = useGT();
  const navigation = useNavigation();
  const environmentIds = useBotEnvironmentIds();
  const permitted = useAtomValue(creationTargetsAtom(enabled ? environmentIds : noEnvironments));
  const targets = permitted[kind].filter(
    ({ id }) => eligibleIds === undefined || eligibleIds.has(id),
  );
  const title = kind === "bot" ? gt("New bot") : gt("New room");
  const items = targets.map((target) => ({
    id: target.id,
    title: target.title,
    subtitle: targets.some((other) => other.id !== target.id && other.title === target.title)
      ? (target.address ?? target.id)
      : undefined,
    onPress: () => {
      if (kind === "bot") navigation.navigate("BotEditor", { environmentId: target.id });
      else navigation.navigate("BotRoomEditor", { environmentId: target.id });
    },
  }));
  const [first] = items;
  return {
    title,
    onPress: items.length === 1 ? first?.onPress : undefined,
    menu: items.length > 1 ? { title, icon: "plus" as const, items } : undefined,
  };
}
