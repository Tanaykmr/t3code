import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentBot,
  type EnvironmentBotRoom,
  botDmThreadKeys,
  sortBots,
} from "@t3tools/client-runtime/state/bots";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { connectedEnvironmentIdsAtom, environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const EMPTY_BOTS: ReadonlyArray<EnvironmentBot> = Object.freeze([]);

/** Connected environments whose server serves the bot directory. */
export const botEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(connectedEnvironmentIdsAtom).filter(
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
}).pipe(Atom.withLabel("mobile-bot-environment-ids"));

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
}).pipe(Atom.withLabel("mobile-environment-bots"));

const EMPTY_ROOMS: ReadonlyArray<EnvironmentBotRoom> = Object.freeze([]);

/** Every room, archived ones included, across connected environments. */
const environmentBotRoomsAtom = Atom.make((get): ReadonlyArray<EnvironmentBotRoom> => {
  const entries = get(botEnvironmentIdsAtom).flatMap((environmentId) =>
    (
      AsyncResult.getOrElse(
        get(serverEnvironment.botsLive({ environmentId, input: {} })),
        () => null,
      )?.rooms ?? []
    ).map((room) => ({ environmentId, room })),
  );
  return entries.length === 0 ? EMPTY_ROOMS : entries;
}).pipe(Atom.withLabel("mobile-environment-bot-rooms"));

/** Bot DM and room seat thread keys, which the ordinary thread lists leave out. */
export const botDmThreadKeysAtom = Atom.make((get) =>
  botDmThreadKeys(get(environmentBotsAtom), get(environmentBotRoomsAtom)),
).pipe(Atom.withLabel("mobile-bot-dm-thread-keys"));

const botByDmThreadKeyAtom = Atom.make(
  (get) =>
    new Map(
      get(environmentBotsAtom).map((entry) => [
        scopedThreadKey(entry.environmentId, entry.bot.dmThreadId),
        entry,
      ]),
    ),
).pipe(Atom.withLabel("mobile-bot-by-dm-thread"));

export function useEnvironmentBots(): ReadonlyArray<EnvironmentBot> {
  return useAtomValue(environmentBotsAtom);
}

export function useEnvironmentBotRooms(): ReadonlyArray<EnvironmentBotRoom> {
  return useAtomValue(environmentBotRoomsAtom);
}

export function useBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(botEnvironmentIdsAtom);
}

/** The bot whose DM this thread is, or null for an ordinary thread. */
export function useBotForThread(ref: ScopedThreadRef | null): EnvironmentBot | null {
  const byThread = useAtomValue(botByDmThreadKeyAtom);
  return ref === null
    ? null
    : (byThread.get(scopedThreadKey(ref.environmentId, ref.threadId)) ?? null);
}
