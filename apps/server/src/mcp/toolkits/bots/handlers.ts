import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotChannelService from "../../../bots/BotChannelService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotsToolkit } from "./tools.ts";

const handlers = {
  t3_bot_message: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const channels = yield* BotChannelService.BotChannelService;
      if (scope.thread === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Only a bot's own thread can message another bot.",
        });
      }
      const sent = yield* channels
        .sendFromThread({ threadId: scope.thread.threadId, to: input.to, text: input.message })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
      return {
        messageId: sent.message.id,
        message: `Sent to ${input.to}. Its answer arrives as a new message; do not wait for it.`,
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BotsToolkit.tools>;

export const layer = McpToolAccess.toLayer(BotsToolkit, handlers);
