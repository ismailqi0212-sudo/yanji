import { tool } from "./definition.mjs";
const str = { type: "string" };
export const finishTool = tool(
  "deliverResearch",
  "交付连贯的研究回答。summary直接回答问题；findings为0–5个自然章节，按需展开分析，关键数字在正文中链接原文；不强制套用卡片模板。",
  {
    summary: str,
    findings: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: str,
          body: str,
          kind: { type: "string", enum: ["fact", "inference", "risk"] },
          nextQuestions: { type: "array", maxItems: 2, items: str },
          sourceIds: { type: "array", items: str },
        },
        required: ["title", "body", "kind", "sourceIds"],
        additionalProperties: false,
      },
    },
    gaps: { type: "array", items: str },
  },
  ["summary", "findings", "gaps"],
);
export const otherTools = [
  tool(
    "getCompanyFilings",
    "查询A股最新公司公告目录或美股SEC申报目录；只有日期标题与原文链接，不代表已阅读正文；港股需上传公告。",
    { ticker: str },
    ["ticker"],
  ),
  tool(
    "chartFromFilings",
    "从上传年报或季报提取一个指标的时间序列，生成可下载图表；沿用原文单位，不计算或估算。",
    { query: str },
    ["query"],
  ),
  tool("findCompany", "查证券代码，代码明确时直接取数。", { query: str }, [
    "query",
  ]),
  tool(
    "searchFilings",
    "检索用户上传的财报和公告。解释经营原因必须读原文。",
    { query: str },
    ["query"],
  ),
  tool(
    "readPage",
    "阅读已上传财报的一页。",
    { documentId: str, page: { type: "integer" } },
    ["documentId", "page"],
  ),
  tool(
    "calculate",
    "确定性计算。growth输入本期、上期；负基数用subtract，不算常规增长率。",
    {
      operation: {
        type: "string",
        enum: ["sum", "subtract", "ratio", "growth", "percentage_points"],
      },
      values: { type: "array", items: { type: "number" } },
      sourceIds: { type: "array", items: str },
    },
    ["operation", "values", "sourceIds"],
  ),
  tool(
    "createChart",
    "用已查询的年度财务数据生成可下载图表。",
    {
      sourceId: str,
      metric: {
        type: "string",
        enum: [
          "revenue",
          "grossMargin",
          "attributableProfit",
          "operatingCashFlow",
          "totalAssets",
          "totalLiabilities",
          "equity",
          "netMargin",
          "debtRatio",
          "eps",
        ],
      },
      kind: { type: "string", enum: ["line", "bar"] },
    },
    ["sourceId", "metric", "kind"],
  ),
  tool(
    "createScenario",
    "创建可编辑的收入与毛利假设沙盘。基准必须来自已查询财务数据，不预测评级或目标价。",
    { sourceId: str, growth: { type: "number", description: "用户明确指定的收入增长率，百分数，例如5表示5%；未指定则省略" }, margin: { type: "number", description: "用户指定的毛利率，百分数；未指定则省略" }, years: { type: "integer", minimum: 1, maximum: 10, description: "测算年数，明年为1；未指定则省略" } },
    ["sourceId"],
  ),
  finishTool,
];
