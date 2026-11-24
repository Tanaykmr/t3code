import { useNavigate } from "@tanstack/react-router";
import { isValidBotName } from "@t3tools/client-runtime/state/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_AVATARS,
  BOT_NAME_MAX_LENGTH,
  BOT_PERSONA_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type Bot,
  type BotAvatar,
  BotId,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import {
  getDefaultProviderInstanceModel,
  providerInstanceEntriesFor,
} from "../../providerInstances";
import { useEnvironmentBots } from "../../state/bots";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BOT_AVATAR_ICONS } from "./BotAvatarIcon";

type EditorRequest =
  | { readonly mode: "create"; readonly environmentId: EnvironmentId }
  | { readonly mode: "edit"; readonly environmentId: EnvironmentId; readonly bot: Bot };

const useEditorRequest = create<{ request: EditorRequest | null }>(() => ({ request: null }));

export function openBotEditor(request: EditorRequest) {
  useEditorRequest.setState({ request });
}

const close = () => useEditorRequest.setState({ request: null });

export function BotEditorDialogHost() {
  const request = useEditorRequest((state) => state.request);
  if (request === null) return null;
  return (
    <BotEditorDialog
      key={request.mode === "edit" ? request.bot.id : `new:${request.environmentId}`}
      request={request}
    />
  );
}

function BotEditorDialog({ request }: { readonly request: EditorRequest }) {
  const gt = useGT();
  const id = useId();
  const navigate = useNavigate();
  const { environmentId } = request;
  const editing = request.mode === "edit" ? request.bot : null;
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const takenNames = new Set(
    useEnvironmentBots()
      .filter(
        (entry) =>
          entry.environmentId === environmentId &&
          entry.bot.archivedAt === null &&
          entry.bot.id !== editing?.id,
      )
      .map((entry) => entry.bot.name.toLowerCase()),
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [avatar, setAvatar] = useState<BotAvatar>(editing?.avatar ?? "bot");
  const [persona, setPersona] = useState(editing?.persona ?? "");
  const [allowedProjectIds, setAllowedProjectIds] = useState<ReadonlyArray<ProjectId>>(
    editing?.allowedProjectIds ?? [],
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(
    editing?.projectId ?? projects[0]?.id ?? null,
  );
  const providerEntries = providerInstanceEntriesFor(providers, settings, projectId).filter(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const selectedInstanceId = instanceId ?? providerEntries[0]?.instanceId ?? null;
  // Stable across retries, so a resend after a lost reply reuses the bot and its DM.
  const [botId] = useState(() => BotId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createBot = useAtomCommand(serverEnvironment.createBot, { label: "bot create" });
  const updateBot = useAtomCommand(serverEnvironment.updateBot, { label: "bot update" });

  const trimmedName = name.trim();
  const nameError =
    trimmedName === ""
      ? null
      : !isValidBotName(trimmedName)
        ? gt("Use letters, numbers, dots, dashes or underscores. No spaces.")
        : takenNames.has(trimmedName.toLowerCase())
          ? gt("Another bot already has this name.")
          : null;
  const model =
    selectedInstanceId === null
      ? undefined
      : getDefaultProviderInstanceModel(providers, selectedInstanceId);
  const canSubmit =
    !busy &&
    trimmedName !== "" &&
    nameError === null &&
    (editing !== null || (projectId !== null && model !== undefined));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const fields = { name: trimmedName, title: title.trim(), avatar, persona };
    const result =
      editing !== null
        ? await updateBot({
            environmentId,
            input: { botId: editing.id, ...fields, allowedProjectIds },
          })
        : await createBot({
            environmentId,
            input: {
              botId,
              ...fields,
              projectId: projectId!,
              modelSelection: { instanceId: selectedInstanceId!, model: model! },
            },
          });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(String(squashAtomCommandFailure(result)));
      return;
    }
    close();
    if (editing === null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.bot.dmThreadId)),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? <T>Edit bot</T> : <T>New bot</T>}</DialogTitle>
            <DialogDescription>
              <T>A bot is a named agent with its own persona and a private chat.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">
                  <T>Avatar</T>
                </span>
                <div role="radiogroup" aria-label={gt("Avatar")} className="flex flex-wrap gap-1.5">
                  {BOT_AVATARS.map((glyph) => {
                    const Icon = BOT_AVATAR_ICONS[glyph];
                    return (
                      <button
                        key={glyph}
                        type="button"
                        role="radio"
                        aria-checked={avatar === glyph}
                        aria-label={glyph}
                        onClick={() => setAvatar(glyph)}
                        className={cn(
                          "flex size-9 items-center justify-center rounded-md border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          avatar === glyph
                            ? "border-foreground/60 text-foreground"
                            : "border-border",
                        )}
                      >
                        <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-name`}>
                  <T>Name</T>
                  <Input
                    nativeInput
                    id={`${id}-name`}
                    autoFocus
                    required
                    maxLength={BOT_NAME_MAX_LENGTH}
                    placeholder={gt("Ada")}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={nameError !== null}
                  />
                </Label>
                <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-title`}>
                  <T>Title</T>
                  <Input
                    nativeInput
                    id={`${id}-title`}
                    maxLength={BOT_TITLE_MAX_LENGTH}
                    placeholder={gt("Release engineer")}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Label>
              </div>
              {nameError ? <p className="-mt-2 text-xs text-destructive">{nameError}</p> : null}
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-persona`}>
                <T>Persona</T>
                <Textarea
                  id={`${id}-persona`}
                  rows={5}
                  maxLength={BOT_PERSONA_MAX_LENGTH}
                  placeholder={gt("How this bot works, what it cares about, and how it talks.")}
                  value={persona}
                  onChange={(event) => setPersona(event.target.value)}
                />
              </Label>
              {editing === null ? null : (
                <fieldset className="flex flex-col gap-1">
                  <legend className="mb-1 text-sm font-medium">
                    <T>Work targets</T>
                  </legend>
                  <p className="mb-1 text-xs text-muted-foreground">
                    <T>Projects this bot may start coding work in, besides its home project.</T>
                  </p>
                  {projects
                    .filter((project) => project.id !== editing.projectId)
                    .map((project) => (
                      <Label key={project.id}>
                        <Checkbox
                          checked={allowedProjectIds.includes(project.id)}
                          onCheckedChange={(checked) =>
                            setAllowedProjectIds(
                              checked === true
                                ? [...allowedProjectIds, project.id]
                                : allowedProjectIds.filter((id) => id !== project.id),
                            )
                          }
                        />
                        {project.title}
                      </Label>
                    ))}
                </fieldset>
              )}
              {editing === null ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-project`}>
                    <T>Home project</T>
                    <Select
                      value={projectId}
                      items={Object.fromEntries(
                        projects.map((project) => [project.id, project.title]),
                      )}
                      onValueChange={(value) => setProjectId(value)}
                    >
                      <SelectTrigger id={`${id}-project`} className="min-w-0">
                        <SelectValue placeholder={gt("Choose a project")} />
                      </SelectTrigger>
                      <SelectPopup>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Label>
                  <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-provider`}>
                    <T>Agent</T>
                    <Select
                      value={selectedInstanceId}
                      items={Object.fromEntries(
                        providerEntries.map((entry) => [entry.instanceId, entry.displayName]),
                      )}
                      onValueChange={(value) => setInstanceId(value)}
                    >
                      <SelectTrigger id={`${id}-provider`} className="min-w-0">
                        <SelectValue placeholder={gt("Choose an agent")} />
                      </SelectTrigger>
                      <SelectPopup>
                        {providerEntries.map((entry) => (
                          <SelectItem key={entry.instanceId} value={entry.instanceId}>
                            {entry.displayName}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Label>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost-muted" onClick={close}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {editing ? <T>Save</T> : <T>Create bot</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
