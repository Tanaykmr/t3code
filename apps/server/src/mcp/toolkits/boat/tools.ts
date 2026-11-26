import {
  BoatCreateInput,
  BoatError,
  BoatLifecycleInput,
  BoatOperationReceipt,
  BoatSnapshot,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import { BoatService } from "../../../boat/BoatService.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([BoatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    BoatService,
    ServerEnvironment,
    ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};

const list = Tool.make("t3_boat_list", {
  ...shared,
  description:
    "List Boat machines and operation status on this controller. Use the managed ID for lifecycle actions.",
  success: BoatSnapshot,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const lifecycle = Tool.make("t3_boat_lifecycle", {
  ...shared,
  description:
    "Create, stop, resume, or delete a Boat machine. Reuse the same UUID requestId on retries. A receipt means queued; check t3_boat_list for the outcome. Create and resume incur charges, stop interrupts work, and delete permanently removes the stopped disk and its threads. Set confirmed only after the user authorizes deletion.",
  parameters: Schema.Union([
    Schema.Struct({ action: Schema.Literal("create"), ...BoatCreateInput.fields }),
    Schema.Struct({ action: Schema.Literal("stop"), ...BoatLifecycleInput.fields }),
    Schema.Struct({ action: Schema.Literal("resume"), ...BoatLifecycleInput.fields }),
    Schema.Struct({
      action: Schema.Literal("delete"),
      ...BoatLifecycleInput.fields,
      confirmed: Schema.Literal(true),
    }),
  ]),
  success: BoatOperationReceipt,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const BoatToolkit = Toolkit.make(list, lifecycle);
