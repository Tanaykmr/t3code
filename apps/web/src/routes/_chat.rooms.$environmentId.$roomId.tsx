import { createFileRoute } from "@tanstack/react-router";
import { BotRoomId, EnvironmentId } from "@t3tools/contracts";

import { BotRoomView } from "../components/bots/BotRoomView";

function BotRoomRouteView() {
  const { environmentId, roomId } = Route.useParams();
  return (
    <BotRoomView
      key={`${environmentId}:${roomId}`}
      environmentId={EnvironmentId.make(environmentId)}
      roomId={BotRoomId.make(roomId)}
    />
  );
}

export const Route = createFileRoute("/_chat/rooms/$environmentId/$roomId")({
  component: BotRoomRouteView,
});
