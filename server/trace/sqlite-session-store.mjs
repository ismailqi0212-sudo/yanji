import { randomUUID } from "node:crypto";
import { SessionStore } from "./session-store.mjs";

const errorData = (e) =>
  e
    ? { code: e.code || e.name || "ERROR", message: String(e.message || e) }
    : undefined;

/**
 * SQLite adapter; constructed by composition root with an open DB and legacy
 * project repository. No filesystem/global store import or automatic recovery.
 * Compatibility writes preserve runs.records/events/checkpoint for existing UI.
 */
export class SQLiteSessionStore extends SessionStore {
  constructor({
    db,
    getProject,
    putProject,
    listChats,
    clock = () => new Date().toISOString(),
  }) {
    super();
    Object.assign(this, { db, getProject, putProject, listChats, clock });
    db.exec(`CREATE TABLE IF NOT EXISTS agent_trace_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      run_id TEXT NOT NULL, span_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_trace_events_run ON agent_trace_events(session_id,run_id,seq);
      CREATE TABLE IF NOT EXISTS agent_model_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_model_calls_run ON agent_model_calls(session_id,run_id);
      CREATE TABLE IF NOT EXISTS agent_trace_steps (
      span_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_trace_steps_run ON agent_trace_steps(session_id,run_id);`);
  }
  /** Report lifecycle updates UI job telemetry through the sole persistence boundary, never writes report content. */
  updateReportJob(cid, changes) {
    const c = this.getProject(cid);
    c.reportJob = { ...c.reportJob, ...structuredClone(changes) };
    this.putProject(c);
  }
  /** ModelService records attribution before IO; does not store prompts, credentials or hidden reasoning. */
  startModelCall(call) {
    this.load(call.sessionId, call.runId);
    this.db
      .prepare(
        "INSERT INTO agent_model_calls(id,session_id,run_id,body) VALUES(?,?,?,?)",
      )
      .run(call.id, call.sessionId, call.runId, JSON.stringify(call));
  }
  /** Exactly-once completion and usage update share a transaction, independent of business result acceptance. */
  finishModelCall(call) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const saved = this.db
        .prepare("SELECT body FROM agent_model_calls WHERE id=?")
        .get(call.id);
      if (!saved) throw new Error("模型调用不存在");
      if (JSON.parse(saved.body).status === "running") {
        this.db
          .prepare("UPDATE agent_model_calls SET body=? WHERE id=?")
          .run(JSON.stringify(call), call.id);
        this.updateRun(call.sessionId, call.runId, (_, run) => {
          run.usage = (run.usage || 0) + call.usage;
        });
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Report tool commits a validated draft atomically, guarding selection, card and report versions. */
  commitReport(cid, rid, report, expected, audit) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const c = this.getProject(cid),
        run = c.runs.find((r) => r.id === rid);
      if (run?.status !== "running") throw new Error("组稿任务已结束");
      const cards = c.cards.filter((x) => x.selected && x.kind !== "gaps");
      if (
        (c.report?.version || 0) !== expected.version ||
        JSON.stringify(cards.map((x) => x.id)) !==
          JSON.stringify(expected.ids) ||
        cards.some((x) => x.version !== expected.versions[x.id])
      )
        throw Object.assign(new Error("所选内容已变化，请重新编成研报"), {
          status: 409,
          code: "COMMIT_CONFLICT",
        });
      if (c.report) c.reports.push(structuredClone(c.report));
      c.report = structuredClone(report);
      c.revision++;
      this.putProject(c);
      this.recordToolVerification(cid, rid, audit);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** Application creates a run through this boundary; does not start or schedule execution. */
  createRun(cid, run, user, assistant) {
    const chat = this.getProject(cid);
    if (chat.runs.some((r) => r.status === "running"))
      throw new Error("请先等待当前任务结束或停止");
    if (user && assistant) chat.messages.push(user, assistant);
    chat.runs.push(run);
    if (user && chat.messages.length === 2)
      chat.title = user.text.replace(/\s+/g, " ").slice(0, 30);
    this.putProject(chat);
  }
  /** Execution pipeline reads a detached session through the persistence port. */
  sessionSnapshot(cid) {
    return this.getProject(cid);
  }
  /** Domain progress is telemetry only; it cannot publish sources/cards or alter run status. */
  recordToolProgress(cid, rid, delta) {
    if (!Object.keys(delta).length) return;
    this.updateRun(cid, rid, (_, r) => {
      if (delta.usage !== undefined) r.usage = (r.usage || 0) + delta.usage;
      if (delta.documentProgress !== undefined)
        r.documentProgress = structuredClone(delta.documentProgress);
      if (delta.records?.length)
        r.records.push(...structuredClone(delta.records));
    });
  }
  /** Append acceptance/rejection to the active span; direct service tests use an explicit runtime span ID. */
  recordToolVerification(cid, rid, payload) {
    const active = this.db
      .prepare(
        "SELECT span_id FROM agent_trace_events WHERE session_id=? AND run_id=? AND kind='started' ORDER BY seq DESC LIMIT 1",
      )
      .get(cid, rid);
    this.appendEvent(
      cid,
      rid,
      active?.span_id || "tool:" + payload.callId,
      "tool_verification",
      payload,
    );
  }
  /** Atomic compare-and-commit of pending business effects; no network/LLM work occurs in this transaction. */
  commitToolResult(pending, audit) {
    const { sessionId: cid, runId: rid, changes, runChanges } = pending;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const c = this.getProject(cid),
        run = c.runs.find((r) => r.id === rid);
      if (!run) throw new Error("研究任务不存在");
      if (run.status && run.status !== "running")
        throw Object.assign(new Error("任务已结束，工具结果未提交"), {
          code: "RUN_NOT_ACTIVE",
        });
      if (
        pending.requiresReportVersion &&
        c.report?.version !== pending.reportVersion
      )
        throw Object.assign(new Error("研报版本已变化，工具结果未提交"), {
          code: "COMMIT_CONFLICT",
        });
      for (const change of changes)
        if (JSON.stringify(c[change.key]) !== JSON.stringify(change.before))
          throw Object.assign(
            new Error("研究内容已变化，工具结果未提交：" + change.key),
            { code: "COMMIT_CONFLICT" },
          );
      for (const change of runChanges)
        if (JSON.stringify(run[change.key]) !== JSON.stringify(change.before))
          throw Object.assign(new Error("任务内容已变化，工具结果未提交"), {
            code: "COMMIT_CONFLICT",
          });
      for (const change of changes)
        c[change.key] = structuredClone(change.after);
      for (const change of runChanges)
        run[change.key] = structuredClone(change.after);
      if (changes.length || runChanges.length) {
        c.revision = (c.revision || 0) + 1;
        this.putProject(c);
      }
      if (audit) this.recordToolVerification(cid, rid, audit);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Runtime/legacy callers receive detached JSON snapshots, never live DB state. */
  load(cid, rid) {
    const c = this.getProject(cid);
    const run = c.runs.find((r) => r.id === rid);
    if (!run) throw new Error("研究任务不存在");
    return structuredClone(run);
  }
  /** Compatibility boundary for existing application mutations, removed as callers migrate. */
  updateRun(cid, rid, change) {
    const c = this.getProject(cid),
      r = c.runs.find((x) => x.id === rid);
    if (!r) throw new Error("研究任务不存在");
    change(c, r);
    this.putProject(c);
  }
  /** Legacy UI event adapter; does not construct model context. */
  event(cid, rid, label, detail = "") {
    this.updateRun(cid, rid, (_, r) =>
      r.events.push({
        at: this.clock(),
        label,
        detail: String(detail).slice(0, 300),
      }),
    );
  }
  /** Compatibility source commit for current tools; verification boundary migrates in step 5. */
  addSource(cid, data, name) {
    const source = {
      id: "S" + randomUUID().replaceAll("-", ""),
      documentId: "",
      name,
      type: "web",
      page: 1,
      date: this.clock(),
      sourceUrl: data.sourceUrl || "",
      text: JSON.stringify(data, null, 2),
      data,
    };
    const c = this.getProject(cid);
    c.researchSources.push(source);
    this.putProject(c);
    return source;
  }
  /** Compatibility artifact commit; no model calls or data fetching. */
  addArtifact(cid, rid, card) {
    this.updateRun(cid, rid, (c, r) => {
      c.cards.push(card);
      c.messages.find((m) => m.id === r.messageId).cardIds.push(card.id);
    });
    return card;
  }
  /** Checkpoints replace only the latest snapshot; trace history remains append-only. */
  checkpoint(
    cid,
    rid,
    { messages, trajectory = [], step, seen = [], calculations = [] },
  ) {
    this.updateRun(cid, rid, (_, r) => {
      r.checkpoint = {
        step,
        messages: structuredClone(messages),
        trajectory: structuredClone(trajectory),
        seen: [...seen],
        calculations: structuredClone(calculations),
        at: this.clock(),
      };
      r.round = step;
    });
  }
  /** Resolve only explicit source pointers against this session; never infer sources from prose. */
  sources(cid, result) {
    const ids = new Set();
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (k === "sourceId" && typeof x === "string") ids.add(x);
        else if (k === "sourceIds" && Array.isArray(x)) {
          for (const id of x) if (typeof id === "string") ids.add(id);
        }
        if (x && typeof x === "object") walk(x);
      }
    };
    walk(result);
    const c = this.getProject(cid);
    const cardIds = new Set();
    const collectCards = (value) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.cardId === "string") cardIds.add(value.cardId);
      for (const id of value.cardIds || []) cardIds.add(id);
      for (const x of Object.values(value))
        if (x && typeof x === "object") collectCards(x);
    };
    collectCards(result);
    for (const card of c.cards || [])
      if (cardIds.has(card.id))
        for (const sid of card.sourceIds || []) ids.add(sid);
    return [...ids].map((id) => {
      const external = c.researchSources.find((s) => s.id === id);
      if (external)
        return {
          id,
          kind:
            external.data?.input && external.data?.basePeriod
              ? "user"
              : "external",
          label: external.name,
          uri: external.sourceUrl || undefined,
          observedAt: external.date,
        };
      for (const d of c.documents || []) {
        const chunk = d.chunks?.find((x) => x.id === id);
        if (chunk)
          return {
            id,
            kind: "document",
            label: d.name,
            page: chunk.page,
            uri: `/api/chats/${cid}/documents/${d.id}/file`,
          };
      }
      return { id, kind: "unknown", label: id, resolved: false };
    });
  }
  /** Preserve legacy record shape plus optional timing metadata; no second trace writer. */
  commitObservation(cid, rid, call, result, metadata = {}) {
    this.updateRun(cid, rid, (_, r) =>
      r.records.push({
        callId: call.id,
        actor: call.actor || "model",
        name: call.function.name,
        args: call.function.arguments,
        result,
        at: this.clock(),
        ...metadata,
      }),
    );
  }
  /** Persist explicit terminal reason while keeping the legacy status contract. */
  finish(cid, rid, outcome) {
    this.updateRun(cid, rid, (_, r) => {
      r.termination = {
        ...outcome,
        ...(r.status === "cancelled" ? { reason: "cancelled" } : {}),
        at: this.clock(),
      };
    });
  }
  /** Append an event before/after work so partial rounds survive process exit. */
  appendEvent(cid, rid, spanId, kind, payload) {
    this.db
      .prepare(
        "INSERT INTO agent_trace_events(session_id,run_id,span_id,kind,body) VALUES(?,?,?,?,?)",
      )
      .run(
        cid,
        rid,
        spanId,
        kind,
        JSON.stringify({ at: this.clock(), ...payload }),
      );
  }
  /** Append final immutable step. Duplicate span completion is refused by SQLite. */
  appendStep(cid, rid, step) {
    this.db
      .prepare("INSERT INTO agent_trace_steps VALUES(?,?,?,?)")
      .run(step.spanId, cid, rid, JSON.stringify(step));
  }
  /** Called by runtime once per host/model/repair round; span has no tool business knowledge. */
  beginStep(cid, rid, { step, phase = "research", actor = "model" }) {
    this.load(cid, rid);
    const spanId = randomUUID(),
      startedAt = this.clock(),
      start = performance.now();
    const record = {
      spanId,
      runId: rid,
      step,
      phase,
      actor,
      startedAt,
      rawDecision: null,
      calls: [],
    };
    let closed = false;
    this.appendEvent(cid, rid, spanId, "started", { step, phase, actor });
    return {
      decision: (response) => {
        if (closed) throw new Error("轨迹轮次已经结束");
        record.rawDecision = structuredClone(response);
        record.decisionDurationMs = Math.max(0, performance.now() - start);
        this.appendEvent(cid, rid, spanId, "decision", {
          rawDecision: record.rawDecision,
          decisionDurationMs: record.decisionDurationMs,
        });
      },
      observation: (call, args, result, timing = {}, error) => {
        if (closed) throw new Error("轨迹轮次已经结束");
        const source = this.sources(cid, result);
        const observation = {
          callId: call.id,
          toolName: call.function.name,
          status:
            result?.status === "rejected"
              ? "rejected"
              : result?.skipped
                ? "skipped"
                : result?.error || error
                  ? "error"
                  : "success",
          data: result,
          sources: source,
          timing,
          error: errorData(error || result?.error),
        };
        const entry = {
          callId: call.id,
          name: call.function.name,
          args: args ?? null,
          rawArguments: call.function.arguments,
          source,
          observation,
        };
        record.calls.push(entry);
        this.appendEvent(cid, rid, spanId, "observation", entry);
      },
      end: ({ status = "continued", error } = {}) => {
        if (closed) return;
        record.status = status;
        record.error = errorData(error);
        record.durationMs = Math.max(0, performance.now() - start);
        this.appendStep(cid, rid, record);
        this.appendEvent(cid, rid, spanId, "ended", {
          status,
          error: record.error,
          durationMs: record.durationMs,
        });
        closed = true;
      },
    };
  }
  /** Inspection/replay readers obtain snapshots; no runtime state is mutated. */
  readTrace(cid, rid) {
    this.load(cid, rid);
    return {
      modelCalls: this.db
        .prepare(
          "SELECT body FROM agent_model_calls WHERE session_id=? AND run_id=? ORDER BY rowid",
        )
        .all(cid, rid)
        .map((x) => JSON.parse(x.body)),
      steps: this.db
        .prepare(
          "SELECT body FROM agent_trace_steps WHERE session_id=? AND run_id=? ORDER BY rowid",
        )
        .all(cid, rid)
        .map((x) => JSON.parse(x.body)),
      events: this.db
        .prepare(
          "SELECT * FROM agent_trace_events WHERE session_id=? AND run_id=? ORDER BY seq",
        )
        .all(cid, rid)
        .map((x) => ({ ...x, body: JSON.parse(x.body) })),
    };
  }
  /** Explicit startup-only recovery; importing any module must not interrupt running tasks. */
  recoverInterrupted() {
    for (const row of this.db
      .prepare("SELECT id,body FROM agent_model_calls")
      .all()) {
      const call = JSON.parse(row.body);
      if (call.status === "running")
        this.db
          .prepare("UPDATE agent_model_calls SET body=? WHERE id=?")
          .run(
            JSON.stringify({
              ...call,
              status: "interrupted",
              usageKnown: false,
              finishedAt: this.clock(),
            }),
            row.id,
          );
    }
    for (const c of this.listChats()) {
      let changed = false;
      if (c.reportJob?.status === "running") {
        Object.assign(c.reportJob, {
          status: "interrupted",
          stage: "stopped",
          error: "服务已重启，请重新组稿",
        });
        changed = true;
      }
      for (const r of c.runs || [])
        if (r.status === "running") {
          Object.assign(r, {
            status: "interrupted",
            error: "服务已重启，可以重新发送问题",
            termination: { reason: "interrupted", at: this.clock() },
          });
          changed = true;
        }
      if (changed) this.putProject(c);
    }
  }
}
