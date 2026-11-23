import { BOT_MESSAGE_MAX_LENGTH, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BotChannelService from "../../../bots/BotChannelService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const BotMessageTool = Tool.make("t3_bot_message", {
  description:
    "Send a message to another bot by name. It wakes that bot. From your private chat its answer comes back to you as a new message; in a room it is posted to the room. The other bot sees only what you write, so include the whole request.",
  parameters: Schema.Struct({
    to: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "The other bot's name, such as Bolt.",
    }),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BOT_MESSAGE_MAX_LENGTH)),
  }),
  success: Schema.Struct({ messageId: Schema.String, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    BotChannelService.BotChannelService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Message another bot")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessBotThread);

export const BotsToolkit = Toolkit.make(BotMessageTool);
