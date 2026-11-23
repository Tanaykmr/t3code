import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveRestoreIcon, FolderIcon, PencilIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useBotForThread } from "../../state/bots";
import { useProject } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { openBotEditor } from "./BotEditorDialog";

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
  const [busy, setBusy] = useState(false);
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
        <ThreadDetailsControl disabled={busy} onClick={() => void toggleArchive()}>
          {archived ? (
            <ArchiveRestoreIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          ) : (
            <ArchiveIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          {archived ? <T>Restore bot</T> : <T>Archive bot</T>}
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}
