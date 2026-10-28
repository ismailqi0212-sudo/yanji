import { db, getProject, putProject, listChats } from "../memory/store.mjs";
import { SQLiteSessionStore } from "./sqlite-session-store.mjs";
/** Composition root for the legacy SQLite adapter; no recovery on import. */
export const sessionStore = new SQLiteSessionStore({
  db,
  getProject,
  putProject,
  listChats,
});
/** Application injects a scoped trace port; Loop knows neither SQLite nor session storage layout. */
export const traceForRun = (cid, rid) => ({
  beginStep: (metadata) => sessionStore.beginStep(cid, rid, metadata),
});
