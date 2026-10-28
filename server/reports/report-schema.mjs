import { tool } from "../tools/definition.mjs";
export const reportTool = tool(
  "writeReport",
  "输出可审阅研报，不编造缺失信息。",
  {
    title: { type: "string" },
    sections: {
      type: "array",
      maxItems: 9,
      items: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title", "content"],
        additionalProperties: false,
      },
    },
  },
  ["title", "sections"],
);
