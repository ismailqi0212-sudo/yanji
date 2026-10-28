import { alignmentMessages } from "../../context/extraction-context.mjs";
import { tool } from "../definition.mjs";
import { model } from "../../llm/client.mjs";
import { jsonrepair } from "jsonrepair";
import { applyOperatingGroups } from "../../research/operating-alignment.mjs";
const alignmentTool = tool(
  "alignOperatingMetrics",
  "只提出相同经营指标的名称归并，不修改数字或期间。",
  {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          factIds: { type: "array", items: { type: "integer" } },
          reason: { type: "string" },
        },
        required: ["factIds", "reason"],
        additionalProperties: false,
      },
    },
  },
  ["groups"],
);
export async function alignOperatingMetrics(
  facts,
  { signal, llm = model } = {},
) {
  if (facts.length < 2) return { facts, warnings: [], usage: 0 };
  const response = await llm(alignmentMessages(facts), {
    tools: [alignmentTool],
    force: "alignOperatingMetrics",
    signal,
    maxTokens: 4000,
  });
  const call = response.tool_calls?.find(
    (t) => t.function.name === "alignOperatingMetrics",
  );
  if (!call) throw new Error("名称归并未返回可校验结果");
  return {
    ...applyOperatingGroups(
      facts,
      JSON.parse(jsonrepair(call.function.arguments)).groups,
    ),
    usage: response.usage || 0,
    call,
  };
}
