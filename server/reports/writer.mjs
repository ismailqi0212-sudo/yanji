import { reviewDraft } from "./reviewer.mjs";
import { reportComputations } from "./computations.mjs";
export { reportComputations } from "./computations.mjs";
import { id, now } from "../memory/store.mjs";
import { refs } from "../tools/documents/documents.mjs";
import { sessionStore } from "../trace/runtime-store.mjs";
import {
  reportAssembler,
  sectionAssembler,
} from "../context/report-context.mjs";
import { runReport } from "./report-runtime.mjs";
import {
  NoopVerifier,
  ToolVerificationError,
} from "../verification/verifier.mjs";

/** API asks to compile confirmed artifacts. Domain validation stays deterministic; AgentLoop owns all retry/termination decisions. */
export async function compileReport(cid, format = "full", options = {}) {
  const initial = sessionStore.sessionSnapshot(cid);
  if (
    initial.reportJob?.status === "running" ||
    initial.runs.some((r) => r.status === "running")
  )
    throw new Error("请等待当前研究或组稿结束");
  if (!["full", "brief"].includes(format)) throw new Error("不支持该报告类型");
  const cards = initial.cards.filter((c) => c.selected && c.kind !== "gaps");
  if (!cards.length)
    throw new Error("先勾选需要写进研报的研究卡片、表格或图表");
  if (cards.length > 20) throw new Error("请先将选中材料缩减到20项以内");
  const before = initial.report?.version || 0,
    versions = Object.fromEntries(cards.map((c) => [c.id, c.version]));
  const sourceIds = [...new Set(cards.flatMap((c) => c.sourceIds))],
    computed = reportComputations(initial, cards, sourceIds);
  const verifier = options.verifier || new NoopVerifier();
  setJob(cid, {
    status: "running",
    stage: "preparing",
    at: now(),
    error: null,
  });
  try {
    await runReport({
      cid,
      mode: "report",
      signal: options.signal,
      transport: options.transport,
      maxTokens: format === "brief" ? 3000 : 7500,
      assembler: (registry) =>
        reportAssembler({
          initial,
          cards,
          sourceIds,
          computed,
          format,
          registry,
        }),
      onEvent: (type, data) => {
        if (type === "started") setJob(cid, { runId: data.runId });
        if (type === "thinking") setJob(cid, { stage: "writing" });
      },
      execute: async (input, { runId, signal, callId }) => {
        const data = structuredClone(input);
        if (
          !data.title ||
          !Array.isArray(data.sections) ||
          !data.sections.length ||
          data.sections.some(
            (s) => typeof s.title !== "string" || typeof s.content !== "string",
          )
        )
          throw new Error("研报结构不完整");
        if (!cards.some((c) => c.kind === "scenario"))
          data.sections = data.sections.filter(
            (s) => !/(情景|假设沙盘)/.test(s.title),
          );
        if (!data.sections.length) throw new Error("研报没有可用章节");
        if (data.sections.length > (format === "brief" ? 4 : 9))
          throw new Error("报告章节过多，请合并空泛或重复章节");
        setJob(cid, { stage: "reviewing" });
        const review = reviewDraft(initial, data, sourceIds, computed);
        const verdict = await verifier.verify(
          {
            toolName: "writeReport",
            data: structuredClone(data),
            sources: sessionStore.sources(cid, { sourceIds }),
          },
          { sessionId: cid, runId, task: { goal: "编成研报" } },
        );
        signal.throwIfAborted();
        if (verdict?.accepted !== true)
          throw new ToolVerificationError(verdict?.reason);
        const report = {
          id: id(),
          title: data.title,
          format,
          review,
          at: now(),
          version: before + 1,
          stale: false,
          sourceIds,
          cardVersions: versions,
          sections: data.sections.map((s) => ({
            id: id(),
            title: s.title,
            content: s.content,
          })),
          artifacts: structuredClone(
            cards.filter((x) =>
              ["worksheet", "chart", "scenario", "financials"].includes(x.kind),
            ),
          ),
        };
        sessionStore.commitReport(
          cid,
          runId,
          report,
          { version: before, versions, ids: cards.map((x) => x.id) },
          { callId, name: "writeReport", status: "accepted", sourceIds },
        );
        return { done: true, reportId: report.id, sourceIds };
      },
    });
    setJob(cid, { status: "completed", stage: "completed", finishedAt: now() });
    return sessionStore.sessionSnapshot(cid);
  } catch (error) {
    setJob(cid, {
      status:
        options.signal?.aborted ||
        sessionStore.sessionSnapshot(cid).reportJob?.status === "cancelled"
          ? "cancelled"
          : "failed",
      stage: "stopped",
      error: error.message,
      finishedAt: now(),
    });
    if (error.code === "COMMIT_CONFLICT") error.status = 409;
    throw error;
  }
}
/** API requests a proposal. Validates in the same loop but leaves explicit user acceptance and versioning to the existing API. */
export async function reviseSection(cid, sectionId, instruction, options = {}) {
  const c = sessionStore.sessionSnapshot(cid),
    section = c.report?.sections.find((s) => s.id === sectionId);
  if (!section) throw new Error("章节不存在");
  if (!String(instruction || "").trim()) throw new Error("请填写修改要求");
  const result = await runReport({
    cid,
    mode: "section-edit",
    signal: options.signal,
    transport: options.transport,
    maxTokens: 2300,
    assembler: (registry) =>
      sectionAssembler({ c, section, instruction, registry }),
    execute: async (data, { signal }) => {
      const content = data.sections?.[0]?.content;
      if (typeof content !== "string") throw new Error("修改建议为空");
      for (const eid of refs(content))
        if (!c.report.sourceIds.includes(eid))
          throw new Error("修改引入了未确认来源");
      reviewDraft(
        c,
        { sections: [{ title: section.title, content }] },
        c.report.sourceIds,
        reportComputations(
          c,
          c.cards.filter((card) => card.selected),
          c.report.sourceIds,
        ),
      );
      signal.throwIfAborted();
      if (
        sessionStore.sessionSnapshot(cid).report?.version !== c.report.version
      )
        throw Object.assign(new Error("研报版本已变化，请重新修改"), {
          code: "COMMIT_CONFLICT",
        });
      return {
        done: true,
        proposal: { sectionId, content, baseVersion: c.report.version },
        sourceIds: c.report.sourceIds,
      };
    },
  });
  return result.proposal;
}
function setJob(cid, changes) {
  sessionStore.updateReportJob(cid, changes);
}
