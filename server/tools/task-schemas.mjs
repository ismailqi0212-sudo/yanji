/** Discovery-only descriptions. No model, storage or business implementation imports. */
import { tool } from "./definition.mjs";
const str = { type: "string" };
export const worksheetTool = tool(
  "buildOperatingWorksheet",
  "读取多份上传报告，按公司、业务指标、期间及单位对齐经营数据表；代码安全拆分累计流量的单季度。用户可点击任意指标画图、下载表格。",
  { focus: str, metrics: { type: "array", maxItems: 12, items: str } },
  ["focus"],
);

export const analyzeTool = tool(
  "analyzeDocuments",
  "长上下文阅读全部上传报告的可提取文字，逐份建立有页码和原文引文的分析底稿；超长文本分批完整阅读，不仅是关键词检索。首次上传材料研究先调用此工具。",
  { focus: str },
  ["focus"],
);

export const planTool = tool(
  "planResearch",
  "复杂研究开始时保存目标、研究步骤和资料缺口；此计划不是已完成结果。",
  {
    goal: str,
    steps: { type: "array", minItems: 1, maxItems: 6, items: str },
    gaps: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          question: str,
          dimension: {
            type: "string",
            enum: ["temporal", "comparison", "deep_dive", "market"],
          },
        },
        required: ["question", "dimension"],
        additionalProperties: false,
      },
    },
  },
  ["goal", "steps", "gaps"],
);

export const gapTool = tool(
  "updateResearchGap",
  "记录缺口补查结果。answered代表已补充依据，必须给出已读来源，不代表原因已完全证实。",
  {
    gapId: str,
    status: { type: "string", enum: ["open", "blocked", "answered"] },
    note: str,
    sourceIds: { type: "array", items: str },
  },
  ["gapId", "status", "note", "sourceIds"],
);

export const readReportTool = tool(
  "readCurrentReport",
  "读取已保存研报章节、版本与来源。修改前先读取。",
  {},
  [],
);

export const revisionTool = tool(
  "proposeReportRevision",
  "交付指定章节的待确认修改。必须依据已读取来源，保留无法核实之处。不会直接覆盖原稿。",
  {
    sectionId: str,
    title: str,
    content: str,
    reason: str,
    sourceIds: { type: "array", items: str },
    remainingGaps: { type: "array", items: str },
  },
  ["sectionId", "title", "content", "reason", "sourceIds", "remainingGaps"],
);
