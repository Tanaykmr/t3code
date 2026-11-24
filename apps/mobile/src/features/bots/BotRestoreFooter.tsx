import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { BotId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { Text, View, type ViewStyle } from "react-native";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ReadOnlyComposerBar } from "../threads/ReadOnlyComposerBar";

type RestoreBot = {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly enabled: boolean;
};

export function BotComposerSlot(props: {
  readonly restore?: RestoreBot;
  readonly children: ReactNode;
  readonly style: ViewStyle;
}) {
  if (!props.restore) return props.children;
  return (
    <View className="self-center px-3 pt-1.5" style={props.style}>
      <BotRestoreFooter {...props.restore} />
    </View>
  );
}

function BotRestoreFooter(props: RestoreBot) {
  const gt = useGT();
  const restore = useAtomCommand(serverEnvironment.restoreBot, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const restoreBot = async () => {
    if (!props.enabled || busy) return;
    setBusy(true);
    const result = await restore({
      environmentId: props.environmentId,
      input: { botId: props.botId },
    });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(gt("Could not restore bot"), cause instanceof Error ? cause.message : undefined);
    }
  };
  return (
    <ReadOnlyComposerBar>
      <View className="w-full gap-5 py-2 pe-2">
        <Text className="text-center text-sm text-foreground-muted">
          {gt("Archived · Read-only")}
        </Text>
        <Button
          fullWidth
          tone="contrast"
          label={gt("Restore bot")}
          loading={busy}
          disabled={!props.enabled}
          onPress={() => void restoreBot()}
        />
      </View>
    </ReadOnlyComposerBar>
  );
}
