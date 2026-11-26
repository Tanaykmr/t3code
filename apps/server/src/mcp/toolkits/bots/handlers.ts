import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotChannelService from "../../../bots/BotChannelService.ts";
import * as BotKnowledgeService from "../../../bots/BotKnowledgeService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotsToolkit } from "./tools.ts";

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const callerThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Only a bot's own thread can use this tool.",
    });
  }
  return scope.thread.threadId;
});

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
  t3_bot_remember: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      const knowledge = yield* BotKnowledgeService.BotKnowledgeService;
      return yield* knowledge
        .rememberFromThread({ threadId, text: input.memory })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_bot_forget: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread;
      const knowledge = yield* BotKnowledgeService.BotKnowledgeService;
      yield* knowledge
        .forgetFromThread({ threadId, memoryId: input.memoryId })
        .pipe(Effect.mapError(toFailure));
      return { forgotten: input.memoryId };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BotsToolkit.tools>;

export const layer = McpToolAccess.toLayer(BotsToolkit, handlers);
