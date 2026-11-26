import { isBotProvider, type ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";

export function botProviderRejection(
  instanceId: ProviderInstanceId,
  settings: ServerSettings | null,
): string | undefined {
  const driverKind = settings?.providerInstances?.[instanceId]?.driver ?? instanceId;
  return isBotProvider({ driverKind, instanceId })
    ? undefined
    : "Bots run on Codex or Claude for now. Pick one of those agents.";
}
