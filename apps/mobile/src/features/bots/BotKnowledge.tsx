import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BOT_MEMORY_MAX_LENGTH,
  BOT_SKILL_MAX_LENGTH,
  type BotId,
  type BotSkill,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const FIELD_CLASS = "min-h-11 rounded-[16px] bg-grouped-card px-3 text-base text-foreground";

/** What the bot remembers and the skills it follows, editable from its overview. */
export function BotKnowledge(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
}) {
  const gt = useGT();
  const knowledge = AsyncResult.getOrElse(
    useAtomValue(
      serverEnvironment.botKnowledgeLive({
        environmentId: props.environmentId,
        input: { botId: props.botId },
      }),
    ),
    () => null,
  );
  const saveMemory = useAtomCommand(serverEnvironment.saveBotMemory, { reportFailure: false });
  const saveSkill = useAtomCommand(serverEnvironment.saveBotSkill, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteBotKnowledge, { reportFailure: false });
  const canSaveMemory = useAtomValue(
    serverEnvironment.saveBotMemory.permissionAtom(props.environmentId),
  );
  const canSaveSkill = useAtomValue(
    serverEnvironment.saveBotSkill.permissionAtom(props.environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteBotKnowledge.permissionAtom(props.environmentId),
  );
  const [memoryDraft, setMemoryDraft] = useState("");
  const [skillDraft, setSkillDraft] = useState<{ name: string; instructions: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settle = (result: Awaited<ReturnType<typeof remove>>) => {
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not save"));
      return false;
    }
    setError(null);
    return true;
  };
  const target = { environmentId: props.environmentId };
  const toggleSkill = async (skill: BotSkill, enabled: boolean) =>
    settle(
      await saveSkill({
        ...target,
        input: {
          botId: props.botId,
          skillId: skill.id,
          name: skill.name,
          instructions: skill.instructions,
          enabled,
        },
      }),
    );
  const addMemory = async () => {
    const text = memoryDraft.trim();
    if (text === "") return;
    const saved = settle(
      await saveMemory({ ...target, input: { botId: props.botId, memoryId: uuidv4(), text } }),
    );
    if (saved) setMemoryDraft("");
  };
  const addSkill = async () => {
    if (skillDraft === null) return;
    const name = skillDraft.name.trim();
    const instructions = skillDraft.instructions.trim();
    if (name === "" || instructions === "") return;
    const saved = settle(
      await saveSkill({
        ...target,
        input: { botId: props.botId, skillId: uuidv4(), name, instructions, enabled: true },
      }),
    );
    if (saved) setSkillDraft(null);
  };

  return (
    <>
      <View className="gap-3 border-t border-border-subtle pt-3">
        <Text className="font-t3-medium text-xs text-foreground-muted">{gt("Memory")}</Text>
        {(knowledge?.memories ?? []).map((memory) => (
          <View key={memory.id} className="flex-row items-start gap-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground">{memory.text}</Text>
            <Text className="text-xs text-foreground-muted">
              {memory.source === "bot" ? gt("from chat") : gt("added")}
            </Text>
            {canDelete ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Forget")}
                hitSlop={8}
                onPress={async () =>
                  settle(
                    await remove({
                      ...target,
                      input: { botId: props.botId, kind: "memory", id: memory.id },
                    }),
                  )
                }
              >
                <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" />
              </Pressable>
            ) : null}
          </View>
        ))}
        {canSaveMemory ? (
          <TextInput
            accessibilityLabel={gt("Add something to remember")}
            placeholder={gt("Add something to remember")}
            placeholderTextColorClassName="accent-foreground-muted"
            maxLength={BOT_MEMORY_MAX_LENGTH}
            returnKeyType="done"
            value={memoryDraft}
            onChangeText={setMemoryDraft}
            onSubmitEditing={() => void addMemory()}
            className={FIELD_CLASS}
          />
        ) : null}
      </View>
      <View className="gap-3 border-t border-border-subtle pt-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-t3-medium text-xs text-foreground-muted">{gt("Skills")}</Text>
          {canSaveSkill ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={gt("Add skill")}
              hitSlop={8}
              onPress={() => setSkillDraft({ name: "", instructions: "" })}
            >
              <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
            </Pressable>
          ) : null}
        </View>
        {(knowledge?.skills ?? []).map((skill) => (
          <View key={skill.id} className="flex-row items-center gap-3">
            <ThemedSwitch
              accessibilityLabel={gt("Use {skill}", { skill: skill.name })}
              value={skill.enabled}
              disabled={!canSaveSkill}
              onValueChange={(enabled) => void toggleSkill(skill, enabled)}
            />
            <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
              {skill.name}
            </Text>
            {canDelete ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Delete {skill}", { skill: skill.name })}
                hitSlop={8}
                onPress={async () =>
                  settle(
                    await remove({
                      ...target,
                      input: { botId: props.botId, kind: "skill", id: skill.id },
                    }),
                  )
                }
              >
                <SymbolView name="trash" size={14} tintColorClassName="accent-icon-muted" />
              </Pressable>
            ) : null}
          </View>
        ))}
        {skillDraft === null || !canSaveSkill ? null : (
          <View className="gap-2">
            <TextInput
              accessibilityLabel={gt("Skill name")}
              placeholder={gt("Skill name")}
              placeholderTextColorClassName="accent-foreground-muted"
              value={skillDraft.name}
              onChangeText={(name) => setSkillDraft({ ...skillDraft, name })}
              className={FIELD_CLASS}
            />
            <TextInput
              multiline
              accessibilityLabel={gt("Skill instructions")}
              placeholder={gt("When to use it and what to do")}
              placeholderTextColorClassName="accent-foreground-muted"
              maxLength={BOT_SKILL_MAX_LENGTH}
              value={skillDraft.instructions}
              onChangeText={(instructions) => setSkillDraft({ ...skillDraft, instructions })}
              className="min-h-24 rounded-[16px] bg-grouped-card p-3 text-base text-foreground"
              style={{ textAlignVertical: "top" }}
            />
            <View className="flex-row justify-end gap-5">
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setSkillDraft(null)}>
                <Text className="text-base text-foreground-muted">{gt("Cancel")}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void addSkill()}>
                <Text className="text-base text-primary-text">{gt("Add skill")}</Text>
              </Pressable>
            </View>
          </View>
        )}
        {error ? (
          <Text selectable className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
    </>
  );
}
