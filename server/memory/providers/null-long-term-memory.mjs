/**
 * Default provider injected into ContextAssembler. Reserves cross-session memory
 * without querying other sessions, creating a vector store, or persisting findings.
 */
export class NullLongTermMemoryProvider {
  /** Assembler calls retrieve with explicit scope; no data is returned or inferred. */
  async retrieve(scope) {
    return { items: [], sources: [] };
  }
}
