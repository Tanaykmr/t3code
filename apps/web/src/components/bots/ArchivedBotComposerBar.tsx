import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BotId, EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ArchiveRestoreIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ReadOnlyComposerBar, ReadOnlyComposerStatus } from "../chat/ReadOnlyComposerBar";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ArchivedBotComposerBar(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const restore = useAtomCommand(serverEnvironment.restoreBot, { label: "bot restore" });
  const canRestore = useAtomValue(serverEnvironment.restoreBot.permissionAtom(props.environmentId));
  const [busy, setBusy] = useState(false);
  const disabled = props.disabled || !canRestore || busy;

  async function restoreBot() {
    if (disabled) return;
    setBusy(true);
    const result = await restore({
      environmentId: props.environmentId,
      input: { botId: props.botId },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not restore bot"),
        description: String(squashAtomCommandFailure(result)),
      });
    }
  }

  return (
    <ReadOnlyComposerBar
      actions={
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void restoreBot()}>
          <ArchiveRestoreIcon aria-hidden />
          <T>Restore bot</T>
        </Button>
      }
    >
      <ReadOnlyComposerStatus>
        <T>Archived · Read-only</T>
      </ReadOnlyComposerStatus>
    </ReadOnlyComposerBar>
  );
}
