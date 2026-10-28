/** Legacy compatibility facade. All persistence is delegated to SessionStore. */
import { sessionStore } from "../trace/runtime-store.mjs";
export const updateRun = (...args) => sessionStore.updateRun(...args);
export const event = (...args) => sessionStore.event(...args);
export const addSource = (...args) => sessionStore.addSource(...args);
export const addArtifact = (...args) => sessionStore.addArtifact(...args);
export const saveCheckpoint = (...args) => sessionStore.checkpoint(...args);
export const recordObservation = (...args) =>
  sessionStore.commitObservation(...args);
