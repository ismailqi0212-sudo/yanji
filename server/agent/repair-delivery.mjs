import { sessionStore, traceForRun } from "../trace/runtime-store.mjs";
import { jsonrepair } from "jsonrepair";
import { model } from "../llm/client.mjs";
import { createRepairAssembler } from "../context/repair-context.mjs";
import { getProject, now } from "../memory/store.mjs";
import {
  recordObservation,
  updateRun,
  saveCheckpoint,
} from "../memory/run-state.mjs";
import { AgentLoop } from "./agent-loop.mjs";

/** Recovery policy prepares a terminal-only configuration; no LLM or control loop runs here. */
export function prepareRepair({ cid, run, seen, calculations, tools }) {
  const c = getProject(cid),
    stored = c.runs.find((r) => r.id === run.id);
  const candidate = stored.records
    .filter((t) => t.name === "deliverResearch")
    .at(-1);
  if (!candidate) throw new Error("没有可修复的已保存交付");
  let parsed;
  try {
    parsed = JSON.parse(jsonrepair(candidate.args));
  } catch {}
  const draft =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { findings: [], gaps: [] };
  const refs = [
    ...new Set(
      (Array.isArray(draft.findings) ? draft.findings : []).flatMap(
        (f) => f.sourceIds || [],
      ),
    ),
  ]
    .flatMap((s) => calculations.find((c) => c.id === s)?.sourceIds || [s])
    .filter((s) => seen.has(s));
  return {
    assembler: createRepairAssembler({
      chat: c,
      stored,
      draft,
      refs,
      calculations,
      tools,
    }),
    registry: terminalRegistry(tools),
    maxSteps: 2,
    maxToolCalls: 2,
    llmOptions: { maxTokens: 5200 },
  };
}
/** Recovery can describe/invoke only allowed terminal tools, even if the model ignores forced tool selection. */
function terminalRegistry(tools) {
  const list = async () =>
    tools.list
      ? (await tools.list()).filter((e) => e.terminal)
      : [
          {
            ...(tools.finish?.function || {
              name: "deliverResearch",
              description: "交付",
              parameters: { type: "object" },
            }),
            terminal: true,
          },
        ];
  return {
    list,
    invoke: async (name, args, meta) => {
      if (!(await list()).some((e) => e.name === name))
        throw new Error("修复阶段禁止重新取数");
      return tools.invoke
        ? tools.invoke(name, args, meta)
        : tools.execute(name, args, meta);
    },
  };
}
/** Legacy direct repair adapter. It delegates to AgentLoop; no separate retry loop remains. */
export async function repairDelivery(context) {
  const { cid, run, seen, calculations, signal, llm = model } = context;
  const config = prepareRepair(context),
    stored = getProject(cid).runs.find((r) => r.id === run.id);
  const loop = new AgentLoop({
    llm,
    registry: config.registry,
    assembler: config.assembler,
    trace: traceForRun(cid, run.id),
    memory: {
      observe: (...args) => recordObservation(cid, run.id, ...args),
      checkpoint: (s) =>
        saveCheckpoint(cid, run.id, { ...s, seen, calculations }),
    },
    onUsage: (tokens) => updateRun(cid, run.id, (_, r) => (r.usage += tokens)),
  });
  const outcome = await loop.run({
    state: {
      sessionId: cid,
      runId: run.id,
      task: { goal: run.question, sourceMode: run.sourceMode },
    },
    signal,
    phase: "repair",
    stepOffset: stored.round || 9,
    maxSteps: 2,
    maxToolCalls: 2,
    requireTerminal: true,
    llmOptions: config.llmOptions,
  });
  if (outcome.reason !== "completed")
    throw Object.assign(
      new Error(outcome.error?.message || "交付校验仍未通过"),
      { outcome },
    );
  updateRun(cid, run.id, (c, r) => {
    Object.assign(r, {
      status: "completed",
      stage: "completed",
      error: null,
      finishedAt: now(),
      recoveredAfterValidation: true,
    });
    c.messages.find((m) => m.id === r.messageId).text = outcome.result.summary;
    r.events.push({
      at: now(),
      label: "已核对并修复交付",
      detail: "复用已读材料；有限修稿，未查询外部数据。",
    });
  });
  sessionStore.finish(cid, run.id, {
    ...outcome,
    recoveredAfterValidation: true,
  });
  return outcome.result;
}
