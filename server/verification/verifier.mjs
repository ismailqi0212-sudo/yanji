/**
 * Optional verification port called after execution and before business commit.
 * It may accept/reject a candidate but must not publish artifacts or call tools.
 * Existing deterministic domain guards still execute inside the isolated workspace.
 */
export class NoopVerifier {
  /** Default preserves current valid behavior; it does not establish financial truth. */
  async verify(observation, state) {
    return { accepted: true, observation };
  }
}
/** Rejection is observable to Loop/Trace but never becomes successful evidence. */
export class ToolVerificationError extends Error {
  constructor(reason) {
    super(reason || "工具结果未通过校验");
    this.name = "ToolVerificationError";
    this.code = "VERIFICATION_REJECTED";
  }
}
