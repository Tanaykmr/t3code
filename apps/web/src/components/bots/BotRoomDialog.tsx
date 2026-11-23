import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_ROOM_MAX_MEMBERS,
  type BotId,
  type BotRoom,
  BotRoomId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useId, useState } from "react";
import { create } from "zustand";

import { randomUUID } from "../../lib/utils";
import { useEnvironmentBots } from "../../state/bots";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BotAvatarIcon } from "./BotAvatarIcon";

type RoomRequest =
  | { readonly mode: "create"; readonly environmentId: EnvironmentId }
  | { readonly mode: "edit"; readonly environmentId: EnvironmentId; readonly room: BotRoom };

const useRoomRequest = create<{ request: RoomRequest | null }>(() => ({ request: null }));

export function openBotRoomEditor(request: RoomRequest) {
  useRoomRequest.setState({ request });
}

const close = () => useRoomRequest.setState({ request: null });

export function BotRoomDialogHost() {
  const request = useRoomRequest((state) => state.request);
  if (request === null) return null;
  return (
    <BotRoomDialog
      key={request.mode === "edit" ? request.room.id : `new:${request.environmentId}`}
      request={request}
    />
  );
}

function BotRoomDialog({ request }: { readonly request: RoomRequest }) {
  const gt = useGT();
  const id = useId();
  const navigate = useNavigate();
  const { environmentId } = request;
  const editing = request.mode === "edit" ? request.room : null;
  const bots = useEnvironmentBots()
    .filter((entry) => entry.environmentId === environmentId && entry.bot.archivedAt === null)
    .map((entry) => entry.bot);
  const [name, setName] = useState(editing?.name ?? "");
  const [members, setMembers] = useState<ReadonlyArray<BotId>>(editing?.memberBotIds ?? []);
  const [defaultBotId, setDefaultBotId] = useState<BotId | null>(editing?.defaultBotId ?? null);
  const [roomId] = useState(() => BotRoomId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createRoom = useAtomCommand(serverEnvironment.createBotRoom, { label: "bot room create" });
  const updateRoom = useAtomCommand(serverEnvironment.updateBotRoom, { label: "bot room update" });
  const responder =
    defaultBotId !== null && members.includes(defaultBotId) ? defaultBotId : members[0];
  const canSubmit = !busy && name.trim() !== "" && members.length > 0 && responder !== undefined;

  const toggle = (botId: BotId, checked: boolean) =>
    setMembers(
      checked
        ? members.length >= BOT_ROOM_MAX_MEMBERS
          ? members
          : [...members, botId]
        : members.filter((member) => member !== botId),
    );

  const submit = async () => {
    if (!canSubmit || responder === undefined) return;
    setBusy(true);
    setError(null);
    const result =
      editing === null
        ? await createRoom({
            environmentId,
            input: { roomId, name: name.trim(), memberBotIds: members, defaultBotId: responder },
          })
        : await updateRoom({
            environmentId,
            input: {
              roomId: editing.id,
              name: name.trim(),
              memberBotIds: members,
              defaultBotId: responder,
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
        to: "/rooms/$environmentId/$roomId",
        params: { environmentId, roomId: result.value.room.id },
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
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? <T>Edit room</T> : <T>New room</T>}</DialogTitle>
            <DialogDescription>
              <T>
                Mention bots to choose who answers. A plain message goes to the default responder.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-name`}>
                <T>Name</T>
                <Input
                  nativeInput
                  id={`${id}-name`}
                  autoFocus
                  required
                  placeholder={gt("Release room")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Label>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">
                  <T>Members</T>
                </legend>
                {bots.map((bot) => (
                  <Label key={bot.id}>
                    <Checkbox
                      checked={members.includes(bot.id)}
                      onCheckedChange={(checked) => toggle(bot.id, checked === true)}
                    />
                    <BotAvatarIcon avatar={bot.avatar} className="size-4 text-muted-foreground" />
                    <span className="text-sm">{bot.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{bot.title}</span>
                  </Label>
                ))}
                {bots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    <T>Create a bot first.</T>
                  </p>
                ) : null}
              </fieldset>
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-default`}>
                <T>Default responder</T>
                <Select
                  value={responder ?? null}
                  items={Object.fromEntries(bots.map((bot) => [bot.id, bot.name]))}
                  onValueChange={(value) => setDefaultBotId(value)}
                >
                  <SelectTrigger id={`${id}-default`} className="min-w-0">
                    <SelectValue placeholder={gt("Choose members first")} />
                  </SelectTrigger>
                  <SelectPopup>
                    {bots
                      .filter((bot) => members.includes(bot.id))
                      .map((bot) => (
                        <SelectItem key={bot.id} value={bot.id}>
                          {bot.name}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </Label>
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
              {editing ? <T>Save</T> : <T>Create room</T>}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
