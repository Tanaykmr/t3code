import {
  createBoatCreateJournal,
  decodeSavedBoatCreates,
  type SavedBoatCreate,
} from "@t3tools/client-runtime/boat";
import { msg } from "gt-react";

import { m } from "../i18n/messages";

const databaseName = "t3code:boat-create-journal";
const storeName = "pending";
let channel: BroadcastChannel | undefined;

function journalChannel() {
  try {
    if (typeof BroadcastChannel !== "undefined") channel ??= new BroadcastChannel(databaseName);
  } catch {
    // Focus still refreshes the journal when browser messaging is unavailable.
  }
  return channel;
}

async function updateJournal(
  change: (saved: ReadonlyArray<SavedBoatCreate>) => ReadonlyArray<SavedBoatCreate>,
): Promise<ReadonlyArray<SavedBoatCreate>> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(storeName);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite", { durability: "strict" });
      const store = transaction.objectStore(storeName);
      const read = store.get("creates");
      let entries: ReadonlyArray<SavedBoatCreate> = [];
      let changed = false;
      transaction.oncomplete = () => {
        resolve(entries);
        if (changed) journalChannel()?.postMessage(null);
      };
      transaction.onabort = () => reject(transaction.error);
      read.onsuccess = () => {
        try {
          const saved = decodeSavedBoatCreates(read.result ?? []);
          entries = change(saved);
          changed = entries !== saved;
          if (changed) store.put(entries, "creates");
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
    });
  } finally {
    database.close();
  }
}

export const boatCreateJournal = createBoatCreateJournal(
  updateJournal,
  () => m(msg("Could not save the request on this device. Try again.")),
  () => Date.now(),
);

export const hasSavedBoatCreate = () => (boatCreateJournal.getSnapshot().entries?.length ?? 0) > 0;

export function subscribeBoatCreateJournal(listener: () => void) {
  const unsubscribe = boatCreateJournal.subscribe(listener);
  const refresh = () => void boatCreateJournal.refresh();
  const messages = journalChannel();
  messages?.addEventListener("message", refresh);
  window.addEventListener("focus", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    messages?.removeEventListener("message", refresh);
    unsubscribe();
  };
}
