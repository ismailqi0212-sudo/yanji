/* Tool descriptions adapted from virattt/ai-financial-agent. Apache-2.0; see LICENSE/NOTICE. */
import { tool } from "./definition.mjs";
const ticker = { type: "string" },
  years = { type: "integer", minimum: 2, maximum: 8 };
export const financialSchemas = [
  tool(
    "getStockPrices",
    "查A股、港股、美股价格、历史走势、估值；工具结果会自动渲染走势图。",
    { ticker },
    ["ticker"],
  ),
  tool(
    "getIncomeStatements",
    "查询A股/港股财务和美股SEC年度财务，含收入、利润、现金流、资产负债、EPS；frequency=latest返回A/HK最新累计期，非单季。",
    {
      ticker,
      years,
      frequency: { type: "string", enum: ["annual", "latest"] },
    },
    ["ticker"],
  ),
  tool(
    "getFinancialMetrics",
    "查询估值和常用财务指标；与行情工具共用数据，不重复调用。",
    { ticker },
    ["ticker"],
  ),
];
