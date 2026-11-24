import { useAtomValue } from "@effect/atom-react";
import { Link, useLocation } from "@tanstack/react-router";
import { type EnvironmentBot, botActivity } from "@t3tools/client-runtime/state/bots";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { memo, useState } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useBotEnvironmentIds, useEnvironmentBotRooms, useEnvironmentBots } from "../../state/bots";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarIcon } from "./BotAvatarIcon";
import { openBotEditor } from "./BotEditorDialog";
import { openBotRoomEditor } from "./BotRoomDialog";

/** The Bots directory above the thread list: one row per bot, opening its DM. */
export function SidebarBotsSection(props: { readonly routeThreadKey: string | null }) {
  const gt = useGT();
  const bots = useEnvironmentBots();
  const [collapsed, setCollapsed] = useLocalStorage(
    "t3code:sidebar-bots-collapsed",
    false,
    Schema.Boolean,
  );
  const environmentIds = useBotEnvironmentIds();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = bots.filter((entry) => entry.bot.archivedAt === null);
  const archived = bots.filter((entry) => entry.bot.archivedAt !== null);
  if (environmentIds.length === 0) return null;
  return (
    <section aria-label={gt("Bots")} className="mb-2">
      <div className="group/bots-header relative flex h-8 items-center">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left text-xs font-medium text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <T>Bots</T>
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
        </button>
        <NewBotButton environmentId={environmentIds[0]!} />
      </div>
      {collapsed ? null : (
        <ul className="flex flex-col gap-px">
          {active.map((entry) => (
            <SidebarBotRow
              key={`${entry.environmentId}:${entry.bot.id}`}
              entry={entry}
              routeThreadKey={props.routeThreadKey}
            />
          ))}
          {active.length === 0 ? (
            <li className="px-(--sidebar-row-content-inset) py-1 text-xs text-sidebar-muted-foreground">
              <T>No bots yet.</T>
            </li>
          ) : null}
          {archived.length > 0 ? (
            <li className="list-none">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen(!archivedOpen)}
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {gt("Archived · {count}", { count: String(archived.length) })}
              </button>
            </li>
          ) : null}
          {archivedOpen
            ? archived.map((entry) => (
                <SidebarBotRow
                  key={`${entry.environmentId}:${entry.bot.id}`}
                  entry={entry}
                  routeThreadKey={props.routeThreadKey}
                />
              ))
            : null}
        </ul>
      )}
      {collapsed ? null : <SidebarRooms environmentId={environmentIds[0]!} />}
    </section>
  );
}

/** Rooms sit under the bots: shared chats where @-chips pick who answers. */
function SidebarRooms(props: { readonly environmentId: EnvironmentBot["environmentId"] }) {
  const gt = useGT();
  const pathname = useLocation({ select: (location) => location.pathname });
  const rooms = useEnvironmentBotRooms();
  const canCreateRoom = useAtomValue(
    serverEnvironment.createBotRoom.permissionAtom(props.environmentId),
  );
  const shown = rooms.filter((entry) => entry.room.archivedAt === null);
  const archived = rooms.length - shown.length;
  return (
    <div className="mt-1">
      <div className="flex h-7 items-center">
        <span className="flex-1 px-(--sidebar-row-content-inset) text-xs text-sidebar-muted-foreground">
          <T>Rooms</T>
        </span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          disabled={!canCreateRoom}
          aria-label={gt("New room")}
          onClick={() => openBotRoomEditor({ mode: "create", environmentId: props.environmentId })}
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
      <ul className="flex flex-col gap-px">
        {[...shown, ...rooms.filter((entry) => entry.room.archivedAt !== null)].map((entry) => {
          const href = `/rooms/${entry.environmentId}/${entry.room.id}`;
          const isActive = pathname === href;
          return (
            <li key={href} className="list-none">
              <Link
                to="/rooms/$environmentId/$roomId"
                params={{ environmentId: entry.environmentId, roomId: entry.room.id }}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-row-hover",
                  entry.room.archivedAt !== null && !isActive && "text-sidebar-muted-foreground",
                )}
              >
                <MessagesSquareIcon
                  aria-hidden
                  strokeWidth={1.75}
                  className="size-4 shrink-0 text-(--sidebar-icon-color)"
                />
                <span className="min-w-0 flex-1 truncate">{entry.room.name}</span>
                <span className="shrink-0 text-xs text-sidebar-muted-foreground">
                  {entry.room.archivedAt !== null
                    ? gt("Archived")
                    : gt("{count} bots", { count: String(entry.room.memberBotIds.length) })}
                </span>
              </Link>
            </li>
          );
        })}
        {rooms.length === 0 || (shown.length === 0 && archived === 0) ? (
          <li className="px-(--sidebar-row-content-inset) py-1 text-xs text-sidebar-muted-foreground">
            <T>No rooms yet.</T>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function NewBotButton(props: { readonly environmentId: EnvironmentBot["environmentId"] }) {
  const gt = useGT();
  const { environmentId } = props;
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId));
  if (!canCreate) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("New bot")}
            onClick={() => openBotEditor({ mode: "create", environmentId })}
          />
        }
      >
        <PlusIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup>
        <T>New bot</T>
      </TooltipPopup>
    </Tooltip>
  );
}

const SidebarBotRow = memo(function SidebarBotRow(props: {
  readonly entry: EnvironmentBot;
  readonly routeThreadKey: string | null;
}) {
  const gt = useGT();
  const { environmentId, bot } = props.entry;
  const ref = scopeThreadRef(environmentId, bot.dmThreadId);
  const shell = useQuietThreadShell(ref);
  const activity = botActivity(shell);
  const isActive = props.routeThreadKey === scopedThreadKey(ref);
  return (
    <li className="list-none">
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(ref)}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-(--sidebar-row-content-inset) py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
          bot.archivedAt !== null && !isActive && "text-sidebar-muted-foreground",
        )}
      >
        <BotAvatarIcon
          avatar={bot.avatar}
          className="size-4 shrink-0 text-(--sidebar-icon-color)"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{bot.name}</span>
          {bot.title === "" ? null : (
            <span className="truncate text-xs text-sidebar-muted-foreground">{bot.title}</span>
          )}
        </span>
        {activity === "idle" ? null : (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              activity === "unread" ? "bg-primary" : "bg-sidebar-muted-foreground/60",
            )}
          >
            <span className="sr-only">
              {activity === "unread" ? gt(", unread reply") : gt(", working")}
            </span>
          </span>
        )}
      </Link>
    </li>
  );
});
