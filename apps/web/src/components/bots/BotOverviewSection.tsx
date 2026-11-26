import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderGit2Icon,
  FolderIcon,
  PencilIcon,
} from "lucide-react";
import { T, msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useBotForThread, useEnvironmentBots } from "../../state/bots";
import { useProject, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadAutomationsPanel } from "../chat/ThreadAutomationsPanel";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { openBotEditor } from "./BotEditorDialog";
import { BotKnowledgeSections } from "./BotKnowledgeSections";

/** The bot's profile at the top of its DM's details; ordinary threads render nothing. */
export function BotOverviewSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const entry = useBotForThread(scopeThreadRef(props.environmentId, props.threadId));
  const bot = entry?.bot ?? null;
  const project = useProject(
    bot === null ? null : scopeProjectRef(props.environmentId, bot.projectId),
  );
  const projectTitles = new Map(
    useProjects()
      .filter((candidate) => candidate.environmentId === props.environmentId)
      .map((candidate) => [candidate.id, candidate.title]),
  );
  const [busy, setBusy] = useState(false);
  const canEdit = useAtomValue(serverEnvironment.updateBot.permissionAtom(props.environmentId));
  const archive = useAtomCommand(serverEnvironment.archiveBot, { label: "bot archive" });
  const restore = useAtomCommand(serverEnvironment.restoreBot, { label: "bot restore" });
  if (bot === null) return null;
  const archived = bot.archivedAt !== null;

  const toggleArchive = async () => {
    setBusy(true);
    const command = archived ? restore : archive;
    const result = await command({ environmentId: props.environmentId, input: { botId: bot.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: archived ? gt("Could not restore bot") : gt("Could not archive bot"),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-bot-heading"
      title={gt("Overview")}
      separated={false}
    >
      <div className="flex flex-col gap-2 px-2.5">
        <div className="flex items-start gap-3">
          <BotAvatarIcon
            avatar={bot.avatar}
            className="mt-0.5 size-6 shrink-0 text-foreground/80"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-base font-semibold">{bot.name}</span>
            {bot.title === "" ? null : (
              <span className="truncate text-xs text-muted-foreground">{bot.title}</span>
            )}
          </div>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={!canEdit}
            aria-label={gt("Edit {name}", { name: bot.name })}
            onClick={() => openBotEditor({ mode: "edit", environmentId: props.environmentId, bot })}
          >
            <PencilIcon aria-hidden />
          </Button>
        </div>
        {bot.persona.trim() === "" ? null : (
          <p className="line-clamp-4 text-xs whitespace-pre-line text-muted-foreground">
            {bot.persona}
          </p>
        )}
        {archived ? (
          <p className="text-xs text-muted-foreground">
            <T>Archived. Restore it to chat again.</T>
          </p>
        ) : null}
      </div>
      <div className="mt-1 flex flex-col">
        <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5 text-sm font-medium text-foreground/80">
          <FolderIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">
            <T>Home project</T>
          </span>
          <span className="truncate text-xs text-muted-foreground">{project?.title ?? ""}</span>
        </div>
        {bot.allowedProjectIds.length > 0 ? (
          <div className="flex h-8 min-w-0 items-center gap-2.5 px-2.5 text-sm font-medium text-foreground/80">
            <FolderGit2Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className="min-w-0 flex-1 truncate">
              <T>Work targets</T>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {bot.allowedProjectIds
                .map((projectId) => projectTitles.get(projectId))
                .filter((title) => title !== undefined)
                .join(", ")}
            </span>
          </div>
        ) : null}
        <ThreadDetailsControl disabled={busy || !canEdit} onClick={() => void toggleArchive()}>
          {archived ? (
            <ArchiveRestoreIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          ) : (
            <ArchiveIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          {archived ? <T>Restore bot</T> : <T>Archive bot</T>}
        </ThreadDetailsControl>
      </div>
      {/* Routines are scheduled tasks bound to the DM; the same panel pauses and runs them. */}
      <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
      <BotKnowledgeSections environmentId={props.environmentId} botId={bot.id} />
      <BotPeerActivity environmentId={props.environmentId} botId={bot.id} />
    </ThreadDetailsSection>
  );
}

const PEER_ACTIVITY_ROWS = 5;
/** Messages this bot exchanged with other bots, and hand-offs out of its DM, newest first. */
function BotPeerActivity(props: { readonly environmentId: EnvironmentId; readonly botId: BotId }) {
  const gt = useGT();
  const m = useMessages();
  const channel = AsyncResult.getOrElse(
    useAtomValue(
      serverEnvironment.botChannelLive({
        environmentId: props.environmentId,
        input: { kind: "bot", botId: props.botId },
      }),
    ),
    () => null,
  );
  const names = new Map(useEnvironmentBots().map(({ bot }) => [bot.id, bot.name]));
  const rows = (channel?.messages ?? []).toReversed().slice(0, PEER_ACTIVITY_ROWS);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border/65 px-2.5 pt-3">
      <h4 className="text-2xs font-medium text-muted-foreground">
        <T>Bot messages</T>
      </h4>
      <ul className="flex flex-col gap-2">
        {rows.map((message) => {
          const from =
            message.sender.kind === "bot"
              ? (names.get(message.sender.botId) ?? gt("Bot"))
              : gt("You");
          const deliveries = (channel?.deliveries ?? []).filter((d) => d.messageId === message.id);
          const to = deliveries.map((d) => names.get(d.targetBotId) ?? gt("Bot")).join(", ");
          const status = deliveries[0]?.status;
          return (
            <li key={message.id} className="flex flex-col gap-0.5 text-xs">
              <span className="text-muted-foreground">
                {to === "" ? from : gt("{from} to {to}", { from, to })}
                {status === undefined ? null : ` · ${m(DELIVERY_STATUS_LABEL[status])}`}
              </span>
              <span className="line-clamp-2 text-foreground/80">{message.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const DELIVERY_STATUS_LABEL = {
  queued: msg("Queued", { $context: "bot delivery status" }),
  accepted: msg("Working", { $context: "bot delivery status" }),
  settled: msg("Delivered", { $context: "bot delivery status" }),
  blocked: msg("Blocked", { $context: "bot delivery status" }),
  cancelled: msg("Stopped", { $context: "bot delivery status" }),
} as const;
