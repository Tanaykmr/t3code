import {
  createBoatCreateJournal,
  decodeSavedBoatCreates,
  type SavedBoatCreate,
} from "@t3tools/client-runtime/boat";
import { msg } from "gt-react";

import { m } from "../i18n/messages";

const databaseName = "t3code:boat-create-journal";
const storeName = "pending";

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
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort = () => reject(transaction.error);
      read.onsuccess = () => {
        try {
          const saved = decodeSavedBoatCreates(read.result ?? []);
          entries = change(saved);
          if (entries !== saved) store.put(entries, "creates");
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

export function subscribeBoatCreateJournal(listener: () => void) {
  const unsubscribe = boatCreateJournal.subscribe(listener);
  const refresh = () => void boatCreateJournal.refresh();
  window.addEventListener("focus", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    unsubscribe();
  };
}
