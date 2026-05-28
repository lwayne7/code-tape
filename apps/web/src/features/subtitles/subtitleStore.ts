import { awaitTransaction, openDatabase, promisifyRequest } from "@/features/library/idb";
import type { SubtitleStore, SubtitleTrack } from "./types";

export type SubtitleStoreOptions = {
  databaseName?: string;
};

const DEFAULT_DB_NAME = "code-tape-subtitles";
const DB_VERSION = 1;
const STORE_SUBTITLES = "subtitles";

export function createSubtitleStore(options: SubtitleStoreOptions = {}): SubtitleStore {
  const databaseName = options.databaseName ?? DEFAULT_DB_NAME;
  const getDb = (() => {
    let cached: Promise<IDBDatabase> | null = null;
    return () => {
      if (!cached) {
        cached = openDatabase({
          name: databaseName,
          version: DB_VERSION,
          onUpgrade(db) {
            if (!db.objectStoreNames.contains(STORE_SUBTITLES)) {
              db.createObjectStore(STORE_SUBTITLES, { keyPath: "recordingId" });
            }
          },
        });
      }
      return cached;
    };
  })();

  return {
    async load(recordingId: string): Promise<SubtitleTrack | null> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readonly");
      const value = (await promisifyRequest(tx.objectStore(STORE_SUBTITLES).get(recordingId))) as
        | SubtitleTrack
        | undefined;
      await awaitTransaction(tx);
      return value ?? null;
    },

    async save(track: SubtitleTrack): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readwrite");
      tx.objectStore(STORE_SUBTITLES).put(track);
      await awaitTransaction(tx);
    },

    async remove(recordingId: string): Promise<void> {
      const db = await getDb();
      const tx = db.transaction(STORE_SUBTITLES, "readwrite");
      tx.objectStore(STORE_SUBTITLES).delete(recordingId);
      await awaitTransaction(tx);
    },
  };
}
