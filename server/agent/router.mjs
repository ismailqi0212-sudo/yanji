import { registeredTool } from "../tools/catalog.mjs";
import { isToolEnabled } from "../tools/tool-registry.mjs";
import { resolveSourcePolicy } from "./source-policy.mjs";
import { getResearchSkill } from "../skills/catalog.mjs";
/** Deterministic task routing. Intent chooses instructions; source policy chooses tools.
 * This is explicit application policy, not an extra LLM pretending to reason. */
const INTENTS = [
  [
    "scenario",
    /假设|情景|沙盘|测算|敏感性/,
    "围绕用户变量做情景分析，先确认基准数据，明确区分假设和已披露事实。",
  ],
  [
    "chart",
    /图表|折线|柱状|走势图|变化图|画图|绘图/,
    "优先交付用户指定指标的图表；简要解释趋势和口径，不扩写无关研究。",
  ],
  [
    "research",
    /为什么|原因|分析|研究|比较|对比|质量|驱动|逻辑|风险|研报/,
    "先回答核心问题，再用证据展开推导；必要时补查反向证据，不机械套用四段模板。",
  ],
  [
    "lookup",
    /股价|行情|市盈率|估值|收入|利润|毛利|财务|多少|查询|查看/,
    "直接回答所查指标、期间和单位；简单查询不扩写多条长发现。",
  ],
];
export function routeTask(chat, question, options = {}) {
  const skill = getResearchSkill(options.skillId);
  if (skill?.requiresDocuments && !chat.documents.length)
    throw new Error("这个任务需要财报材料，请先上传报告再开始");
  const policy = resolveSourcePolicy(chat, question, options);
  // Operating worksheets are a document extraction task even when the UI has no scope selector.
  if (skill?.id === "operating-metrics" && policy.sourceMode === "external")
    throw new Error(
      "经营数据底稿需要读取上传报告；如需外部信息，可直接提问或选择财务体检",
    );
  const { sourceMode } = policy;
  const revision = options.mode === "revision";
  // Negative requests must not accidentally activate the corresponding task.
  const positiveQuestion = question.replace(
    /(?:不需要|无需|不要|不用|不必)(?:新增|生成|制作|绘制|做)?(?:任何)?(?:图表|折线图|柱状图|画图|测算|情景|沙盘)/g,
    "",
  );
  const match = INTENTS.find(([, pattern]) => pattern.test(positiveQuestion));
  const requested = positiveQuestion.match(
    /([1-5一二两三四五])\s*(?:段|条)(?:自然)?(?:分析|发现|结论)?/,
  );
  const count = requested
    ? { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }[requested[1]] ||
      Number(requested[1])
    : 5;
  return {
    skillId: skill?.id,
    skillName: skill?.name,
    maxFindings: skill?.id === "operating-metrics" ? 1 : count,
    intent: revision ? "revision" : match?.[0] || "research",
    sourceMode,
    sourceReason: policy.sourceReason,
    instruction: revision
      ? "先读取目标章节，再补查并提交待确认修订，不能直接覆盖。"
      : match?.[2] || INTENTS[2][2],
    reason: revision
      ? "用户指定章节修订"
      : match
        ? "按问题关键词选择交付侧重点"
        : "开放研究问题",
    maxSteps: 9,
    maxToolCalls: 32,
    timeoutMs: sourceMode === "external" ? 420000 : 900000,
  };
}
/** Compatibility query: permissions come from the registration catalog, not tool-name sets. */
export function allowsTool(route, name) {
  if (!route) return true;
  return isToolEnabled(registeredTool(name), {
    sourceMode: route.sourceMode,
    mode: route.intent === "revision" ? "revision" : "research",
  });
}
