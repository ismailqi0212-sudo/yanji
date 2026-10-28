/**
 * Loop races in-flight model/tool work with external cancellation. The underlying
 * provider still receives signal and owns actual IO cancellation; late results
 * are discarded, not committed by the loop, and late rejection is observed.
 */
export function abortable(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("任务已取消"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
