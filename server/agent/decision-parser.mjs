import { jsonrepair } from "jsonrepair";
/**
 * AgentLoop calls this pure parser. It recognizes observable actions or explicit
 * structured completion, never inspects hidden reasoning or invokes tools.
 */
export function parseDecision(response = {}) {
  if (
    !response ||
    typeof response !== "object" ||
    (response.tool_calls !== undefined && !Array.isArray(response.tool_calls))
  )
    return {
      kind: "invalid",
      actions: [],
      rawDecision: response,
      error: { code: "INVALID_DECISION", message: "模型决策格式无效" },
    };
  if (response.tool_calls?.length)
    return {
      kind: "act",
      actions: response.tool_calls.map((call) => {
        try {
          const args = JSON.parse(jsonrepair(call.function?.arguments || "{}"));
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw new Error("工具参数必须是对象");
          return { call, args };
        } catch (error) {
          return {
            call,
            error: { code: "INVALID_ARGUMENTS", message: error.message },
          };
        }
      }),
      rawDecision: response,
    };
  let value = response.decision;
  if (!value && typeof response.content === "string")
    try {
      value = JSON.parse(response.content);
    } catch {}
  if (
    value?.type === "finish" &&
    typeof value.summary === "string" &&
    value.summary.trim()
  )
    return {
      kind: "finish",
      summary: value.summary,
      output: value.output,
      actions: [],
      rawDecision: response,
    };
  return {
    kind: "invalid",
    actions: [],
    error: { code: "NO_ACTION", message: "需要工具行动或显式结构化完成决策" },
    rawDecision: response,
  };
}
