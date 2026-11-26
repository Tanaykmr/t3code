import { BoatSnapshot, EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { splitEnvironmentSections, withoutBoatGuests } from "./environmentSections";

function connectedEnvironment(
  input: Omit<Partial<ConnectedEnvironmentSummary>, "environmentId"> & {
    readonly environmentId: string;
    readonly isRelayManaged: boolean;
  },
): ConnectedEnvironmentSummary {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    environmentLabel: input.environmentLabel ?? input.environmentId,
    displayUrl: input.displayUrl ?? `https://${input.environmentId}.example.test/`,
    isRelayManaged: input.isRelayManaged,
    isEnabled: input.isEnabled ?? true,
    connectionState: input.connectionState ?? "connected",
    connectionError: input.connectionError ?? null,
    connectionErrorTraceId: input.connectionErrorTraceId ?? null,
  };
}

const decodeBoatSnapshot = Schema.decodeUnknownSync(BoatSnapshot);

function cloudEnvironment(environmentId: string): RelayClientEnvironmentRecord {
  return {
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    endpoint: {
      httpBaseUrl: `https://${environmentId}.cloud.example.test/`,
      wsBaseUrl: `wss://${environmentId}.cloud.example.test/ws`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mobile environment settings sections", () => {
  it("keeps saved relay-managed connections under T3 Connect", () => {
    const local = connectedEnvironment({
      environmentId: "environment-local",
      isRelayManaged: false,
    });
    const cloud = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: true,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [cloud, local],
      cloudEnvironments: [
        cloudEnvironment("environment-cloud"),
        cloudEnvironment("environment-new"),
      ],
    });

    expect(sections.localEnvironments).toEqual([local]);
    expect(sections.connectedCloudEnvironments).toEqual([cloud]);
    expect(
      sections.availableCloudEnvironments.map((environment) => environment.environmentId),
    ).toEqual([EnvironmentId.make("environment-new")]);
  });

  it("keeps saved relay-managed connections visible when cloud listing is unavailable", () => {
    const cloud = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: true,
      connectionState: "reconnecting",
      connectionError: "Environment did not respond before the connection timeout.",
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [cloud],
      cloudEnvironments: null,
    });

    expect(sections.localEnvironments).toEqual([]);
    expect(sections.connectedCloudEnvironments).toEqual([cloud]);
    expect(sections.availableCloudEnvironments).toEqual([]);
  });

  it("still offers a cloud environment saved directly as a local backend", () => {
    const local = connectedEnvironment({
      environmentId: "environment-cloud",
      isRelayManaged: false,
    });

    const sections = splitEnvironmentSections({
      connectedEnvironments: [local],
      cloudEnvironments: [cloudEnvironment("environment-cloud")],
    });

    expect(sections.localEnvironments).toEqual([local]);
    expect(sections.connectedCloudEnvironments).toEqual([]);
    expect(
      sections.availableCloudEnvironments.map((environment) => environment.environmentId),
    ).toEqual([EnvironmentId.make("environment-cloud")]);
  });

  it("lists a paired Boat guest only under Boat machines", () => {
    const controller = connectedEnvironment({
      environmentId: "environment-controller",
      isRelayManaged: false,
    });
    const guest = connectedEnvironment({
      environmentId: "environment-boat-guest",
      isRelayManaged: false,
    });
    const server = {
      displayName: "Scratch",
      size: "small",
      ttlSeconds: 3600,
      lifecycle: "running",
      operation: null,
      sandboxId: "bx_1",
      origin: "https://bx_1.boat.dev",
      observedPower: "running",
      observedAt: null,
      autoStopAt: null,
      retention: "unknown",
      usage: null,
      createdAt: "2026-11-23T10:00:00.000Z",
      lastStartedAt: null,
      lastStoppedAt: null,
    };
    const snapshot = decodeBoatSnapshot({
      account: { status: "configured", label: null },
      rates: [],
      servers: [
        { ...server, managedId: "boat_guest", guestEnvironmentId: guest.environmentId },
        { ...server, managedId: "boat_starting", guestEnvironmentId: null },
      ],
    });

    expect(withoutBoatGuests([controller, guest], [{ snapshot }])).toEqual([controller]);
    expect(withoutBoatGuests([controller, guest], [])).toEqual([controller, guest]);
  });
});
