import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_MEMORY_MAX_LENGTH,
  BOT_SKILL_MAX_LENGTH,
  type BotId,
  type BotSkill,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

/** What the bot remembers and the skills it follows, editable from its overview. */
export function BotKnowledgeSections(props: {
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
  const saveMemory = useAtomCommand(serverEnvironment.saveBotMemory, { label: "bot memory save" });
  const saveSkill = useAtomCommand(serverEnvironment.saveBotSkill, { label: "bot skill save" });
  const remove = useAtomCommand(serverEnvironment.deleteBotKnowledge, {
    label: "bot knowledge delete",
  });
  const [memoryDraft, setMemoryDraft] = useState("");
  const canSaveMemory = useAtomValue(
    serverEnvironment.saveBotMemory.permissionAtom(props.environmentId),
  );
  const canSaveSkill = useAtomValue(
    serverEnvironment.saveBotSkill.permissionAtom(props.environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteBotKnowledge.permissionAtom(props.environmentId),
  );
  const [skillDraft, setSkillDraft] = useState<{ name: string; instructions: string } | null>(null);

  const report = (result: Awaited<ReturnType<typeof remove>>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not save"),
        description: String(squashAtomCommandFailure(result)),
      });
      return false;
    }
    return result._tag === "Success";
  };
  const target = { environmentId: props.environmentId };
  const toggleSkill = async (skill: BotSkill, enabled: boolean) =>
    report(
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

  return (
    <>
      <div className="mt-2 flex flex-col gap-2 border-t border-border/65 px-2.5 pt-3">
        <h4 className="text-2xs font-medium text-muted-foreground">
          <T>Memory</T>
        </h4>
        <ul className="flex flex-col gap-1.5">
          {(knowledge?.memories ?? []).map((memory) => (
            <li key={memory.id} className="group/memory flex items-start gap-2 text-xs">
              <span className="min-w-0 flex-1 text-foreground/80">{memory.text}</span>
              <span className="shrink-0 text-muted-foreground">
                {memory.source === "bot" ? gt("from chat") : gt("added")}
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={!canDelete}
                aria-label={gt("Forget")}
                onClick={async () =>
                  report(
                    await remove({
                      ...target,
                      input: { botId: props.botId, kind: "memory", id: memory.id },
                    }),
                  )
                }
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-1.5"
          onSubmit={async (event) => {
            event.preventDefault();
            const text = memoryDraft.trim();
            if (text === "") return;
            const saved = report(
              await saveMemory({
                ...target,
                input: { botId: props.botId, memoryId: randomUUID(), text },
              }),
            );
            if (saved) setMemoryDraft("");
          }}
        >
          <Input
            nativeInput
            size="sm"
            maxLength={BOT_MEMORY_MAX_LENGTH}
            placeholder={gt("Add something to remember")}
            aria-label={gt("Add something to remember")}
            disabled={!canSaveMemory}
            value={memoryDraft}
            onChange={(event) => setMemoryDraft(event.target.value)}
          />
        </form>
      </div>
      <div className="mt-2 flex flex-col gap-2 border-t border-border/65 px-2.5 pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-2xs font-medium text-muted-foreground">
            <T>Skills</T>
          </h4>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Add skill")}
            disabled={!canSaveSkill}
            onClick={() => setSkillDraft({ name: "", instructions: "" })}
          >
            <PlusIcon aria-hidden />
          </Button>
        </div>
        <ul className="flex flex-col gap-1.5">
          {(knowledge?.skills ?? []).map((skill) => (
            <li key={skill.id} className="flex items-center gap-2 text-xs">
              <Switch
                size="sm"
                disabled={!canSaveSkill}
                checked={skill.enabled}
                aria-label={gt("Use {skill}", { skill: skill.name })}
                onCheckedChange={(checked) => void toggleSkill(skill, checked)}
              />
              <span className="min-w-0 flex-1 truncate text-foreground/80">{skill.name}</span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={!canDelete}
                aria-label={gt("Delete {skill}", { skill: skill.name })}
                onClick={async () =>
                  report(
                    await remove({
                      ...target,
                      input: { botId: props.botId, kind: "skill", id: skill.id },
                    }),
                  )
                }
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {skillDraft === null ? null : (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={async (event) => {
              event.preventDefault();
              if (skillDraft.name.trim() === "" || skillDraft.instructions.trim() === "") return;
              const saved = report(
                await saveSkill({
                  ...target,
                  input: {
                    botId: props.botId,
                    skillId: randomUUID(),
                    name: skillDraft.name.trim(),
                    instructions: skillDraft.instructions.trim(),
                    enabled: true,
                  },
                }),
              );
              if (saved) setSkillDraft(null);
            }}
          >
            <Input
              nativeInput
              size="sm"
              placeholder={gt("Skill name")}
              aria-label={gt("Skill name")}
              value={skillDraft.name}
              onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })}
            />
            <Textarea
              rows={3}
              maxLength={BOT_SKILL_MAX_LENGTH}
              placeholder={gt("When to use it and what to do")}
              aria-label={gt("Skill instructions")}
              value={skillDraft.instructions}
              onChange={(event) =>
                setSkillDraft({ ...skillDraft, instructions: event.target.value })
              }
            />
            <div className="flex justify-end gap-1.5">
              <Button size="xs" variant="ghost-muted" onClick={() => setSkillDraft(null)}>
                <T>Cancel</T>
              </Button>
              <Button size="xs" type="submit">
                <T>Add skill</T>
              </Button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
