import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BOT_ROOM_MAX_MEMBERS, type BotId, BotRoomId, EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FitSheet } from "../../components/ui/FitSheet";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentBotRooms, useEnvironmentBots } from "../../state/bots";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export type BotRoomEditorParams = {
  readonly environmentId: string;
  /** Absent for a new room. */
  readonly roomId?: string;
};

export function BotRoomEditorScreen({ route }: StaticScreenProps<BotRoomEditorParams>) {
  const gt = useGT();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const editing =
    useEnvironmentBotRooms().find(
      (entry) => entry.environmentId === environmentId && entry.room.id === route.params.roomId,
    )?.room ?? null;
  const bots = useEnvironmentBots()
    .filter((entry) => entry.environmentId === environmentId && entry.bot.archivedAt === null)
    .map((entry) => entry.bot);
  const [name, setName] = useState(editing?.name ?? "");
  const [members, setMembers] = useState<ReadonlyArray<BotId>>(editing?.memberBotIds ?? []);
  const [defaultBotId, setDefaultBotId] = useState<BotId | null>(editing?.defaultBotId ?? null);
  // Stable across retries, so a resend after a lost reply reuses the room.
  const [roomId] = useState(() => BotRoomId.make(uuidv4()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const createRoom = useAtomCommand(serverEnvironment.createBotRoom, { reportFailure: false });
  const updateRoom = useAtomCommand(serverEnvironment.updateBotRoom, { reportFailure: false });
  const canWrite = useAtomValue(
    (editing === null
      ? serverEnvironment.createBotRoom
      : serverEnvironment.updateBotRoom
    ).permissionAtom(environmentId),
  );
  const responder =
    defaultBotId !== null && members.includes(defaultBotId) ? defaultBotId : members[0];
  const canSave = canWrite && !busy && name.trim() !== "" && responder !== undefined;

  const toggle = (botId: BotId) =>
    setMembers(
      members.includes(botId)
        ? members.filter((member) => member !== botId)
        : members.length >= BOT_ROOM_MAX_MEMBERS
          ? members
          : [...members, botId],
    );

  const save = async () => {
    if (!canSave || responder === undefined || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const fields = { name: name.trim(), memberBotIds: members, defaultBotId: responder };
    const result =
      editing === null
        ? await createRoom({ environmentId, input: { roomId, ...fields } })
        : await updateRoom({ environmentId, input: { roomId: editing.id, ...fields } });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not update room"));
      return;
    }
    navigation.goBack();
    if (editing === null && AsyncResult.isSuccess(result)) {
      navigation.dispatch(
        StackActions.push("BotRoom", {
          environmentId: String(environmentId),
          roomId: result.value.room.id,
        }),
      );
    }
  };

  return (
    <FitSheet
      avoidsKeyboard
      header={
        <SheetHeader
          title={editing ? gt("Edit room") : gt("New room")}
          subtitle={gt(
            "Mention bots to choose who answers. A plain message goes to the default responder.",
          )}
          onCancel={() => navigation.goBack()}
          dismissDisabled={busy}
        />
      }
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={editing ? gt("Save") : gt("Create room")}
          loading={busy}
          disabled={!canSave}
          onPress={() => void save()}
        />
      }
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 }}
    >
      <View className="gap-4" pointerEvents={busy ? "none" : "auto"}>
        <TextInput
          accessibilityLabel={gt("Name")}
          placeholder={gt("Release room")}
          placeholderTextColorClassName="accent-foreground-muted"
          autoFocus={editing === null}
          value={name}
          onChangeText={setName}
          className="min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground"
        />
        <ListSection title={gt("Members")}>
          {bots.map((bot, index) => (
            <ListChoiceRow
              key={bot.id}
              label={bot.name}
              separated={index > 0}
              selected={members.includes(bot.id)}
              onPress={() => toggle(bot.id)}
            />
          ))}
        </ListSection>
        {bots.length === 0 ? (
          <Text className="text-sm text-foreground-muted">{gt("Create a bot first.")}</Text>
        ) : null}
        {members.length > 0 ? (
          <ListSection title={gt("Default responder")}>
            {members.map((botId, index) => (
              <ListChoiceRow
                key={botId}
                label={bots.find((bot) => bot.id === botId)?.name ?? botId}
                separated={index > 0}
                selected={botId === responder}
                onPress={() => setDefaultBotId(botId)}
              />
            ))}
          </ListSection>
        ) : null}
        {error ? (
          <Text selectable className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
    </FitSheet>
  );
}
