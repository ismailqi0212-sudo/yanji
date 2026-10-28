import { getProject, putProject } from "../memory/store.mjs";
import {
  updateRun,
  event,
  addSource,
  addArtifact,
} from "../memory/run-state.mjs";
const legacy = {
  getProject,
  putProject,
  updateRun,
  event,
  addSource,
  addArtifact,
};
/**
 * Domain compatibility port. Registered tools always receive an isolated workspace.
 * Direct historical service callers may omit it and keep their old commit behavior;
 * no ambient/global execution context is used.
 */
export function toolEffects(injected) {
  return injected || legacy;
}
