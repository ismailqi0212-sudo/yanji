/**
 * Agent runtime contracts, proposed v1. Type documentation only: the current
 * runtime does not import this module. No database, model or tool side effects.
 * These contracts describe future adapters, not capabilities already shipped.
 */
export const AGENT_CONTRACT_VERSION = 1;

/**
 * Source identity carried by tools and consumed by context/trace adapters.
 * It identifies evidence, not its truth; credentials and raw files do not belong here.
 * @typedef {Object} SourceRef
 * @property {string} id Stable evidence ID; existing PDF/source IDs remain valid.
 * @property {'document'|'external'|'calculation'|'user'|'unknown'} kind
 * @property {string} label
 * @property {string} [uri]
 * @property {number} [page] Physical page, one-based.
 * @property {string} [observedAt] ISO timestamp, distinct from publication date.
 * @property {string[]} [parentSourceIds] Operands or upstream evidence.
 */

/**
 * Immutable tool result produced by Registry and consumed by Loop/Verifier/Store.
 * Sources may be empty (e.g. planning or an error), but must always be explicit.
 * It does not commit artifacts or infer that an execution succeeded.
 * @typedef {Object} ToolObservation
 * @property {string} callId
 * @property {string} toolName
 * @property {'success'|'error'|'skipped'|'rejected'} status
 * @property {unknown} data
 * @property {SourceRef[]} sources
 * @property {{code:string,message:string,retryable:boolean}} [error]
 * @property {{startedAt:string,durationMs:number}} timing
 * @property {Object[]} [pendingArtifacts] Submitted only after verification.
 */

/**
 * Parsed model decision consumed by Loop. Parser retains original provider output
 * separately for trace; this is not a record of hidden chain-of-thought.
 * @typedef {Object} Decision
 * @property {'act'|'finish'|'invalid'} kind
 * @property {{call:Object,args?:Object,error?:{code:string,message:string}}[]} actions Ordered provider call envelopes, possibly empty.
 * @property {string} [summary]
 * @property {string} [error]
 * @property {unknown} rawDecision Provider response, excluding secrets/transport headers.
 */

/**
 * Run-owned snapshot passed to ContextAssembler and returned by SessionStore.
 * External modules receive snapshots and emit results, never mutate this object.
 * No credentials, live controllers or database handles are stored here.
 * @typedef {Object} AgentState
 * @property {number} contractVersion
 * @property {string} sessionId
 * @property {string} runId
 * @property {string} [parentRunId]
 * @property {{goal:string,sourceMode:'documents'|'external'|'hybrid',skillId?:string}} task
 * @property {{maxSteps:number,maxToolCalls:number}} limits
 * @property {{step:number,toolCalls:number}} progress
 * @property {ToolObservation[]} observations
 * @property {{type:string,step?:number,response?:Object,call?:Object,result?:unknown}[]} trajectory
 * @property {SourceRef[]} sources
 * @property {{id:string,instruction:string}[]} perspectives
 * @property {'created'|'running'|'completed'|'budget_exhausted'|'cancelled'|'failed'} status
 */

/**
 * Loop result consumed by application assembly; persisted by SessionStore.
 * A terminal outcome does not imply that evidence was sufficient or verified.
 * @typedef {Object} AgentOutcome
 * @property {string} runId
 * @property {'completed'|'budget_exhausted'|'cancelled'|'failed'} reason
 * @property {number} steps
 * @property {number} toolCalls
 * @property {string} [summary]
 * @property {{code:string|number,message:string}} [error]
 * @property {string} [phase]
 * @property {boolean} [recovered]
 * @property {boolean} [recoveryAttempted]
 */

/**
 * Per-step append-only trace owned by SessionStore, consumed by replay/evaluation.
 * It records observable decisions, not private model reasoning; usage is optional.
 * @typedef {Object} StepTrace
 * @property {string} runId
 * @property {number} step
 * @property {unknown} rawDecision
 * @property {{callId:string,name:string,args:Object,observation:ToolObservation}[]} calls
 * @property {string} startedAt
 * @property {number} durationMs
 * @property {{code:string,message:string}} [error]
 * @property {Object} [usage]
 */

/**
 * Called by future Loop; exposes descriptions and a single invocation boundary.
 * It does not construct prompts, own session state, or decide research goals.
 * @typedef {Object} ToolRegistry
 * @property {function(Object=): Promise<Object[]>} list Filter by category/policy.
 * @property {function(string,Object,Object): Promise<ToolObservation>} invoke Name, arguments, invocation metadata including signal.
 */

/**
 * Called once per future Loop iteration. Combines task, memory, constraints and
 * current tool descriptions; does not call LLMs, invoke tools or write state.
 * @typedef {Object} ContextAssembler
 * @property {function(AgentState): Promise<{messages:Object[],tools:Object[]}>} build
 */

/**
 * Called by ContextAssembler; short-term and long-term implementations are
 * injected separately. Retrieval is scope-filtered and does not mutate a run.
 * @typedef {Object} MemoryProvider
 * @property {function(Object): Promise<{items:Object[],sources:SourceRef[]}>} retrieve
 */

/**
 * Called by Loop/application adapters; sole runtime state/trace persistence API.
 * Domain tools return pending results instead of obtaining its database handle.
 * @typedef {Object} SessionStore
 * @property {function(string): Promise<AgentState>} load
 * @property {function(StepTrace): Promise<void>} appendStep
 * @property {function(AgentState): Promise<void>} checkpoint
 * @property {function(string,ToolObservation): Promise<void>} commitObservation
 * @property {function(AgentOutcome): Promise<void>} finish
 */

/**
 * Called between tool execution and observation commit. It may accept/reject a
 * result or request a configured fallback; it neither persists nor trades.
 * @typedef {Object} Verifier
 * @property {function(ToolObservation,AgentState): Promise<{accepted:boolean,observation:ToolObservation,reason?:string}>} verify
 */
