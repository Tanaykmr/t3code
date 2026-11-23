import { isValidBotName } from "@t3tools/client-runtime/state/bots";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BOT_AVATARS,
  BOT_NAME_MAX_LENGTH,
  BOT_PERSONA_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type BotAvatar,
  BotId,
  EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FitSheet } from "../../components/ui/FitSheet";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { cn } from "../../lib/cn";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentBots } from "../../state/bots";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { BotGlyph } from "./BotGlyph";

export type BotEditorParams = {
  readonly environmentId: string;
  /** Absent for a new bot. */
  readonly botId?: string;
};

const FIELD_CLASS = "min-h-12 rounded-[20px] bg-grouped-card px-4 text-base text-foreground";

export function BotEditorScreen({ route }: StaticScreenProps<BotEditorParams>) {
  const gt = useGT();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const entries = useEnvironmentBots().filter((entry) => entry.environmentId === environmentId);
  const editing = entries.find((entry) => entry.bot.id === route.params.botId)?.bot ?? null;
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [avatar, setAvatar] = useState<BotAvatar>(editing?.avatar ?? "bot");
  const [persona, setPersona] = useState(editing?.persona ?? "");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const chosenProjectId = projectId ?? projects[0]?.id ?? null;
  const providers = groupByProvider(
    buildModelOptions(config, null, undefined, chosenProjectId).filter(
      (option) => option.isUnavailable !== true,
    ),
  );
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const provider =
    providers.find((group) => group.providerKey === providerKey) ?? providers[0] ?? null;
  const modelSelection =
    (provider?.models.find((option) => option.isDefault) ?? provider?.models[0])?.selection ?? null;
  // Stable across retries, so a resend after a lost reply reuses the bot and its DM.
  const [botId] = useState(() => BotId.make(uuidv4()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const createBot = useAtomCommand(serverEnvironment.createBot, { reportFailure: false });
  const updateBot = useAtomCommand(serverEnvironment.updateBot, { reportFailure: false });

  const trimmedName = name.trim();
  const taken = entries.some(
    (entry) =>
      entry.bot.archivedAt === null &&
      entry.bot.id !== editing?.id &&
      entry.bot.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  const nameError =
    trimmedName === ""
      ? null
      : !isValidBotName(trimmedName)
        ? gt("Use letters, numbers, dots, dashes or underscores. No spaces.")
        : taken
          ? gt("Another bot already has this name.")
          : null;
  const canSave =
    !busy &&
    trimmedName !== "" &&
    nameError === null &&
    (editing !== null || (chosenProjectId !== null && modelSelection !== null));

  const save = async () => {
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const fields = { name: trimmedName, title: title.trim(), avatar, persona };
    const result =
      editing !== null
        ? await updateBot({ environmentId, input: { botId: editing.id, ...fields } })
        : await createBot({
            environmentId,
            input: {
              botId,
              ...fields,
              projectId: chosenProjectId!,
              modelSelection: modelSelection!,
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not save the bot."));
      return;
    }
    navigation.goBack();
    if (editing === null && AsyncResult.isSuccess(result)) {
      selectDetail({
        name: "Thread",
        params: {
          environmentId: String(environmentId),
          threadId: String(result.value.bot.dmThreadId),
        },
      });
    }
  };

  return (
    <FitSheet
      avoidsKeyboard
      header={
        <SheetHeader
          title={editing ? gt("Edit bot") : gt("New bot")}
          subtitle={gt("A bot is a named agent with its own persona and a private chat.")}
          onCancel={() => navigation.goBack()}
          dismissDisabled={busy}
        />
      }
      footer={
        <Button
          fullWidth
          tone="contrast"
          label={editing ? gt("Save") : gt("Create bot")}
          loading={busy}
          disabled={!canSave}
          onPress={() => void save()}
        />
      }
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 20 }}
    >
      <View className="gap-4" pointerEvents={busy ? "none" : "auto"}>
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
          {BOT_AVATARS.map((glyph) => (
            <Pressable
              key={glyph}
              accessibilityRole="radio"
              accessibilityLabel={glyph}
              accessibilityState={{ checked: avatar === glyph }}
              className={cn(
                "size-11 items-center justify-center rounded-xl border",
                avatar === glyph ? "border-foreground" : "border-border-subtle",
              )}
              onPress={() => setAvatar(glyph)}
            >
              <BotGlyph
                glyph={glyph}
                colorClassName={avatar === glyph ? "accent-foreground" : "accent-icon-muted"}
              />
            </Pressable>
          ))}
        </View>
        <TextInput
          accessibilityLabel={gt("Name")}
          placeholder={gt("Name")}
          placeholderTextColorClassName="accent-foreground-muted"
          autoCapitalize="words"
          autoCorrect={false}
          autoFocus={editing === null}
          maxLength={BOT_NAME_MAX_LENGTH}
          value={name}
          onChangeText={setName}
          className={FIELD_CLASS}
        />
        {nameError ? (
          <Text className="-mt-2 text-xs text-danger-foreground">{nameError}</Text>
        ) : null}
        <TextInput
          accessibilityLabel={gt("Title")}
          placeholder={gt("Title, such as Release engineer")}
          placeholderTextColorClassName="accent-foreground-muted"
          maxLength={BOT_TITLE_MAX_LENGTH}
          value={title}
          onChangeText={setTitle}
          className={FIELD_CLASS}
        />
        <TextInput
          multiline
          accessibilityLabel={gt("Persona")}
          placeholder={gt("How this bot works, what it cares about, and how it talks.")}
          placeholderTextColorClassName="accent-foreground-muted"
          maxLength={BOT_PERSONA_MAX_LENGTH}
          value={persona}
          onChangeText={setPersona}
          className="min-h-36 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
          style={{ textAlignVertical: "top" }}
        />
        {editing === null ? (
          <>
            <ListSection title={gt("Home project")}>
              {projects.map((project, index) => (
                <ListChoiceRow
                  key={project.id}
                  label={project.title}
                  separated={index > 0}
                  selected={project.id === chosenProjectId}
                  onPress={() => setProjectId(project.id)}
                />
              ))}
            </ListSection>
            <ListSection title={gt("Agent")}>
              {providers.map((group, index) => (
                <ListChoiceRow
                  key={group.providerKey}
                  label={group.providerLabel}
                  separated={index > 0}
                  selected={group === provider}
                  onPress={() => setProviderKey(group.providerKey)}
                />
              ))}
            </ListSection>
          </>
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
