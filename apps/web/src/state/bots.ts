import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentBot,
  type EnvironmentBotRoom,
  botDmThreadKeys,
  roomSeatThreadKeys,
  sortBots,
} from "@t3tools/client-runtime/state/bots";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentPresentations, environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

const EMPTY_BOTS: ReadonlyArray<EnvironmentBot> = Object.freeze([]);
const EMPTY_ROOMS: ReadonlyArray<EnvironmentBotRoom> = Object.freeze([]);

/** Connected environments whose server serves the bot directory. */
const botEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
    (environmentId) =>
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.bots === true,
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((id, index) => id === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("web-bot-environment-ids"));

/** Every bot, archived ones included, across connected environments, sorted by name. */
const environmentBotsAtom = Atom.make((get): ReadonlyArray<EnvironmentBot> => {
  const entries = get(botEnvironmentIdsAtom).flatMap((environmentId) => {
    const directory = AsyncResult.getOrElse(
      get(serverEnvironment.botsLive({ environmentId, input: {} })),
      () => null,
    );
    return (directory?.bots ?? []).map((bot) => ({ environmentId, bot }));
  });
  return entries.length === 0 ? EMPTY_BOTS : sortBots(entries);
}).pipe(Atom.withLabel("web-environment-bots"));

const environmentBotRoomsAtom = Atom.make((get): ReadonlyArray<EnvironmentBotRoom> => {
  const entries = get(botEnvironmentIdsAtom).flatMap((environmentId) => {
    const directory = AsyncResult.getOrElse(
      get(serverEnvironment.botsLive({ environmentId, input: {} })),
      () => null,
    );
    return (directory?.rooms ?? []).map((room) => ({ environmentId, room }));
  });
  return entries.length === 0 ? EMPTY_ROOMS : entries;
}).pipe(Atom.withLabel("web-environment-bot-rooms"));

const botDmThreadKeysAtom = Atom.make((get) =>
  botDmThreadKeys(get(environmentBotsAtom), get(environmentBotRoomsAtom)),
).pipe(Atom.withLabel("web-bot-dm-thread-keys"));

const roomSeatKeysAtom = Atom.make(
  (get) => new Set(roomSeatThreadKeys(get(environmentBotRoomsAtom))),
);

export function useIsRoomSeat(ref: ScopedThreadRef | null): boolean {
  const keys = useAtomValue(roomSeatKeysAtom);
  return ref !== null && keys.has(scopedThreadKey(ref));
}

const botByDmThreadKeyAtom = Atom.make(
  (get) =>
    new Map(
      get(environmentBotsAtom).map((entry) => [
        scopedThreadKey({ environmentId: entry.environmentId, threadId: entry.bot.dmThreadId }),
        entry,
      ]),
    ),
).pipe(Atom.withLabel("web-bot-by-dm-thread"));

export function useEnvironmentBots(): ReadonlyArray<EnvironmentBot> {
  return useAtomValue(environmentBotsAtom);
}

export function useEnvironmentBotRooms(): ReadonlyArray<EnvironmentBotRoom> {
  return useAtomValue(environmentBotRoomsAtom);
}

export function useBotDmThreadKeys(): ReadonlySet<string> {
  return useAtomValue(botDmThreadKeysAtom);
}

/** The bot whose DM this thread is, or null for an ordinary thread. */
export function useBotForThread(ref: ScopedThreadRef | null): EnvironmentBot | null {
  const byThread = useAtomValue(botByDmThreadKeyAtom);
  return ref === null ? null : (byThread.get(scopedThreadKey(ref)) ?? null);
}

export function useBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(botEnvironmentIdsAtom);
}
