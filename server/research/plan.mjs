import { toolEffects } from "./effects.mjs";
export { planTool, gapTool } from "../tools/task-schemas.mjs";
/** Durable research notebook. Gap categories are adapted conceptually from DeepFinance. */
import { id, now } from "../memory/store.mjs";
import { evidence } from "../tools/documents/documents.mjs";
export function savePlan(cid, rid, args, effects) {
  const { getProject, putProject } = toolEffects(effects);
  if (
    !String(args.goal || "").trim() ||
    !Array.isArray(args.steps) ||
    !args.steps.length ||
    args.steps.length > 6
  )
    throw new Error("研究计划需目标和1至6个步骤");
  const c = getProject(cid),
    old = c.researchPlan;
  c.researchPlan = {
    goal: String(args.goal).slice(0, 600),
    steps: args.steps.map(String).slice(0, 6),
    at: now(),
    runId: rid,
    gaps: old?.gaps || [],
  };
  for (const gap of (args.gaps || []).slice(0, 8))
    addGap(c, gap.question, gap.dimension);
  const run = c.runs.find((r) => r.id === rid);
  if (run)
    run.plan = { goal: c.researchPlan.goal, steps: c.researchPlan.steps };
  putProject(c);
  return c.researchPlan;
}
function addGap(c, question, dimension = "deep_dive") {
  if (
    !String(question || "").trim() ||
    c.researchPlan.gaps.some((gap) => gap.question === question)
  )
    return;
  c.researchPlan.gaps.push({
    id: id(),
    question: String(question).slice(0, 600),
    dimension: ["temporal", "comparison", "deep_dive", "market"].includes(
      dimension,
    )
      ? dimension
      : "deep_dive",
    status: "open",
    note: "",
    sourceIds: [],
    at: now(),
  });
  c.researchPlan.gaps = c.researchPlan.gaps.slice(-24);
}
export function rememberGaps(cid, rid, questions, effects) {
  const { getProject, putProject } = toolEffects(effects);
  const c = getProject(cid);
  if (!c.researchPlan)
    c.researchPlan = {
      goal: c.runs.find((r) => r.id === rid)?.question || c.title,
      steps: [],
      gaps: [],
      runId: rid,
      at: now(),
    };
  for (const question of questions) addGap(c, question);
  putProject(c);
}
export function updateGap(cid, args, seen, effects) {
  const { getProject, putProject } = toolEffects(effects);
  const c = getProject(cid),
    gap = c.researchPlan?.gaps.find((g) => g.id === args.gapId);
  if (!gap) throw new Error("缺口不存在，请读取当前研究记忆");
  if (!["open", "blocked", "answered"].includes(args.status))
    throw new Error("缺口状态无效");
  const sourceIds = [...new Set(args.sourceIds || [])];
  if (sourceIds.some((s) => !seen.has(s) || !evidence(c, s)))
    throw new Error("缺口依据必须已读取且属于本项目");
  if (args.status === "answered" && !sourceIds.length)
    throw new Error("没有来源不能标为已补充依据");
  Object.assign(gap, {
    status: args.status,
    note: String(args.note || "").slice(0, 1500),
    sourceIds,
    updatedAt: now(),
  });
  putProject(c);
  return gap;
}
