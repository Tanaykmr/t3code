import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { BoatService } from "../../../boat/BoatService.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { BoatToolkit } from "./tools.ts";

const localBoat = Effect.fn("BoatMcp.localBoat")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  yield* McpInvocationContext.requireThreadScope(scope, "Boat");
  const environment = yield* ServerEnvironment;
  if (scope.environmentId !== (yield* environment.getEnvironmentId)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  }
  return yield* BoatService;
});

export const layer = McpToolAccess.toLayer(BoatToolkit, {
  t3_boat_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const boat = yield* localBoat();
      const snapshot = yield* Stream.runHead(boat.snapshots);
      if (Option.isNone(snapshot)) return yield* unavailable();
      return snapshot.value;
    }),
  ),
  t3_boat_lifecycle: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const boat = yield* localBoat();
      return yield* input.action === "create" ? boat.create(input) : boat[input.action](input);
    }),
  ),
});
