const controls = new Map();
/** Application registers an active run controller; no persistence, scheduling or business state is owned here. */
export function registerRun(runId, controller) {
  controls.set(runId, controller);
  return () => {
    if (controls.get(runId) === controller) controls.delete(runId);
  };
}
/** Stop endpoint signals research/report IO through one boundary; status persistence remains with the caller. */
export function cancelRun(runId) {
  controls.get(runId)?.abort(new Error("任务已停止"));
}
