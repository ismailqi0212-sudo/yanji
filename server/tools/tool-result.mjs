import { randomUUID } from "node:crypto";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const telemetryFields = new Set(["usage", "documentProgress", "records"]);
const businessFields = new Set([
  "cards",
  "messages",
  "researchSources",
  "documentAnalysisCache",
  "researchPlan",
]);
const forbidden = new Set([
  "id",
  "documents",
  "report",
  "reports",
  "revision",
  "updatedAt",
  "runs",
  "at",
  "title",
  "archived",
  "archivedAt",
]);
/**
 * Per-invocation isolated working copy used by domain services. It accumulates
 * pending business changes; it never writes a database or publishes evidence.
 * Only explicit telemetry callbacks may report usage/progress/errors before verify.
 */
export class ToolWorkspace {
  constructor({ sessionId, runId, snapshot, memory, telemetry = {} }) {
    this.sessionId = sessionId;
    this.runId = runId;
    this.base = structuredClone(snapshot);
    this.draft = structuredClone(snapshot);
    this.telemetry = telemetry;
    this.memory = {
      seen: new Set(memory.seen),
      calculations: structuredClone(memory.calculations),
      financialCache: new Set(memory.financialCache || []),
    };
    this.effects = {
      getProject: (id) => this.getProject(id),
      putProject: (c) => this.putProject(c),
      updateRun: (cid, rid, fn) => this.updateRun(cid, rid, fn),
      event: (...args) => this.event(...args),
      addSource: (...args) => this.addSource(...args),
      addArtifact: (...args) => this.addArtifact(...args),
    };
  }
  /** Domain reads a detached snapshot restricted to this session. */
  getProject(id) {
    if (id !== this.sessionId) throw new Error("工具不能读取其他会话");
    return structuredClone(this.draft);
  }
  /** Domain saves into this workspace only, never into SessionStore. */
  putProject(chat) {
    if (chat.id !== this.sessionId) throw new Error("工具不能写入其他会话");
    this.draft = structuredClone(chat);
    return chat;
  }
  /** Compatibility callback stages business edits and emits only explicit run telemetry. */
  updateRun(cid, rid, change) {
    if (rid !== this.runId) throw new Error("工具不能修改其他任务");
    const c = this.getProject(cid),
      run = c.runs.find((r) => r.id === rid);
    if (!run) throw new Error("研究任务不存在");
    const old = structuredClone(run);
    change(c, run);
    this.putProject(c);
    const delta = {};
    for (const key of telemetryFields)
      if (!same(old[key], run[key]))
        delta[key] =
          key === "usage"
            ? (run.usage || 0) - (old.usage || 0)
            : key === "records"
              ? (run.records || []).slice((old.records || []).length)
              : structuredClone(run[key]);
    this.telemetry.progress?.(cid, rid, delta);
  }
  /** Stream telemetry only within the current run; never publish business results. */
  event(cid, rid, ...values) {
    if (cid !== this.sessionId || rid !== this.runId)
      throw new Error("工具不能记录其他任务事件");
    this.telemetry.event?.(cid, rid, ...values);
  }
  /** Stage a source with the same legacy ID/shape; it is not verified or globally visible yet. */
  addSource(cid, data, name) {
    const c = this.getProject(cid);
    const source = {
      id: "S" + randomUUID().replaceAll("-", ""),
      documentId: "",
      name,
      type: "web",
      page: 1,
      date: new Date().toISOString(),
      sourceUrl: data.sourceUrl || "",
      text: JSON.stringify(data, null, 2),
      data: structuredClone(data),
    };
    c.researchSources.push(source);
    this.putProject(c);
    return source;
  }
  /** Stage an artifact and its assistant-message pointer atomically within the working copy. */
  addArtifact(cid, rid, card) {
    this.updateRun(cid, rid, (c, r) => {
      c.cards.push(card);
      const message = c.messages.find((m) => m.id === r.messageId);
      if (!message) throw new Error("任务消息不存在");
      message.cardIds.push(card.id);
    });
    return card;
  }
  /** Verifier receives explicit pointers and matching evidence copies from this candidate workspace. */
  referencedEvidence(data, artifacts) {
    const ids = new Set();
    const walk = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (key === "sourceId" && typeof item === "string") ids.add(item);
        if (key === "sourceIds" && Array.isArray(item))
          for (const id of item) ids.add(id);
        if (item && typeof item === "object") walk(item);
      }
    };
    walk(data);
    walk(artifacts);
    const evidence = [],
      sources = [];
    for (const id of ids) {
      const external = this.draft.researchSources.find((s) => s.id === id);
      if (external) {
        evidence.push(structuredClone(external));
        sources.push({
          id,
          kind:
            external.data?.input && external.data?.basePeriod
              ? "user"
              : "external",
          label: external.name,
          uri: external.sourceUrl || undefined,
        });
        continue;
      }
      let found = false;
      for (const doc of this.draft.documents || []) {
        const chunk = doc.chunks?.find((c) => c.id === id);
        if (chunk) {
          found = true;
          evidence.push(structuredClone(chunk));
          sources.push({
            id,
            kind: "document",
            label: doc.name,
            page: chunk.page,
            uri: `/api/chats/${this.sessionId}/documents/${doc.id}/file`,
          });
          break;
        }
      }
      if (!found)
        sources.push({ id, kind: "unknown", label: id, resolved: false });
    }
    return { sources, evidence };
  }
  /** Pipeline calls this once after execution, exporting data plus explicit pending effects. */
  prepare(data, { name, callId }) {
    const changes = [];
    for (const key of new Set([
      ...Object.keys(this.base),
      ...Object.keys(this.draft),
    ])) {
      if (same(this.base[key], this.draft[key])) continue;
      if (forbidden.has(key)) {
        if (key !== "runs") throw new Error("工具试图修改受保护字段：" + key);
        continue;
      }
      if (!businessFields.has(key))
        throw new Error("工具未声明的提交字段：" + key);
      changes.push({
        key,
        before: structuredClone(this.base[key]),
        after: structuredClone(this.draft[key]),
      });
    }
    if (
      !same(
        this.base.runs.filter((r) => r.id !== this.runId),
        this.draft.runs.filter((r) => r.id !== this.runId),
      )
    )
      throw new Error("工具不能修改其他任务");
    const before = this.base.runs.find((r) => r.id === this.runId),
      after = this.draft.runs.find((r) => r.id === this.runId);
    const runChanges = [];
    for (const key of new Set([
      ...Object.keys(before || {}),
      ...Object.keys(after || {}),
    ])) {
      if (same(before?.[key], after?.[key]) || telemetryFields.has(key))
        continue;
      if (
        [
          "id",
          "status",
          "stage",
          "messageId",
          "question",
          "sourceMode",
          "route",
          "checkpoint",
          "termination",
          "round",
          "error",
          "finishedAt",
          "liveText",
          "events",
        ].includes(key)
      )
        throw new Error("工具试图修改受保护任务字段：" + key);
      runChanges.push({
        key,
        before: structuredClone(before?.[key]),
        after: structuredClone(after?.[key]),
      });
    }
    const oldIds = new Set((this.base.cards || []).map((c) => c.id));
    const artifacts = this.draft.cards.filter((c) => !oldIds.has(c.id));
    const references = this.referencedEvidence(data, artifacts);
    return {
      data: structuredClone(data),
      pending: {
        sessionId: this.sessionId,
        runId: this.runId,
        changes,
        runChanges,
        reportVersion: this.base.report?.version,
        requiresReportVersion: before?.mode === "revision",
      },
      pendingArtifacts: artifacts,
      sources: references.sources,
      evidence: references.evidence,
      newSources: this.draft.researchSources.filter(
        (s) => !this.base.researchSources.some((old) => old.id === s.id),
      ),
      memory: this.memory,
      toolName: name,
      callId,
    };
  }
}
