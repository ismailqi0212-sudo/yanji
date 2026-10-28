/* Adapted from virattt/ai-financial-agent/lib/ai/tools/financial-tools.ts
 * Copyright 2024 Vercel, Inc. Apache-2.0. See LICENSE and NOTICE.
 * Changes: remove SDK-specific Zod wrappers; inject providers; return UI artifacts.
 */
import { financialSchemas } from "../tools/financial-schemas.mjs";
export const financialTools = [
  "getStockPrices",
  "getIncomeStatements",
  "getFinancialMetrics",
];
export class FinancialToolsManager {
  constructor(config, cache = new Set()) {
    this.toolCallCache = cache;
    this.config = config;
  }
  shouldExecuteToolCall(toolName, params) {
    const key = JSON.stringify({ toolName, params });
    if (this.toolCallCache.has(key)) return false;
    this.toolCallCache.add(key);
    return true;
  }
  getTools() {
    return structuredClone(financialSchemas);
  }

  async execute(name, args) {
    if (!financialTools.includes(name)) throw new Error("未知金融工具");
    if (!this.shouldExecuteToolCall(name, args))
      throw new Error("相同数据已经查询，请使用已有结果");
    try {
      return await this.config[name](args);
    } catch (e) {
      this.toolCallCache.delete(
        JSON.stringify({ toolName: name, params: args }),
      );
      throw e;
    }
  }
}
