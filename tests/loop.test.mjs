import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../server/agent/loop.mjs";
const schema = (name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
});
const response = (name, id = "call-1") => ({
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});
test("loop feeds a tool error back to the LLM and continues until a terminal observation", async () => {
  const messages = [{ role: "user", content: "查询" }],
    observations = [],
    checkpoints = [];
  let turns = 0;
  const outcome = await runAgentLoop({
    messages,
    llm: async (history) => {
      turns++;
      if (turns === 2) assert.match(history.at(-1).content, /数据源暂时不可用/);
      return response(turns === 1 ? "lookup" : "finish", "call-" + turns);
    },
    tools: {
      schemas: [schema("lookup"), schema("finish")],
      finish: schema("finish"),
      execute: async (name) => {
        if (name === "lookup") throw new Error("数据源暂时不可用");
        return { done: true, summary: "资料不足，保留缺口" };
      },
    },
    memory: {
      observe: (c, r) => observations.push(r),
      checkpoint: (s) => checkpoints.push(structuredClone(s)),
      compact: () => {},
    },
  });
  assert.equal(outcome.steps, 2);
  assert.equal(observations[0].error, "数据源暂时不可用");
  assert.equal(observations[1].done, true);
  assert.equal(checkpoints.length, 2);
});
test("loop enforces tool and round budgets even when the model ignores forced completion", async () => {
  let executed = 0;
  await assert.rejects(
    () =>
      runAgentLoop({
        messages: [],
        maxSteps: 2,
        maxToolCalls: 1,
        llm: async () => response("lookup"),
        tools: {
          schemas: [schema("lookup"), schema("finish")],
          finish: schema("finish"),
          execute: async () => {
            executed++;
            return { data: 1 };
          },
        },
        memory: { observe: () => {}, checkpoint: () => {}, compact: () => {} },
      }),
    /预算/,
  );
  assert.equal(executed, 1);
});
test("loop observes cancellation before calling the LLM", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let called = false;
  await assert.rejects(() =>
    runAgentLoop({
      messages: [],
      signal: ctrl.signal,
      llm: async () => {
        called = true;
      },
      tools: {},
      memory: {},
    }),
  );
  assert.equal(called, false);
});
test("mandatory source ingestion executes before the model and records host provenance", async () => {
  const events = [],
    messages = [{ role: "user", content: "阅读上传材料" }];
  let ingested = false;
  const result = await runAgentLoop({
    messages,
    llm: async (history) => {
      assert.equal(ingested, true);
      assert.match(history.at(-1).content, /真实材料观察/);
      return response("finish");
    },
    tools: {
      requiredFirst: schema("analyzeDocuments"),
      schemas: [schema("analyzeDocuments"), schema("finish")],
      finish: schema("finish"),
      execute: async (name) => {
        if (name === "analyzeDocuments") {
          ingested = true;
          return { data: "真实材料观察" };
        }
        return { done: true };
      },
    },
    memory: {
      observe: (call) => events.push(call),
      checkpoint: () => {},
      compact: () => {},
    },
  });
  assert.equal(events[0].actor, "host");
  assert.equal(result.toolCalls, 2);
});

test("intent routing separates task focus from source permission and revision writes", async () => {
  const { routeTask, allowsTool } = await import("../server/agent/router.mjs");
  const chat = { documents: [{ id: "annual-report" }] };
  const chart = routeTask(chat, "画收入折线图");
  assert.equal(chart.intent, "chart");
  assert.equal(chart.sourceMode, "documents");
  assert.equal(allowsTool(chart, "getIncomeStatements"), false);
  assert.equal(allowsTool(chart, "chartFromFilings"), true);
  assert.equal(allowsTool(chart, "proposeReportRevision"), false);
  assert.equal(
    routeTask(chat, "分析毛利改善质量，不需要新增图表").intent,
    "research",
  );
  assert.equal(routeTask(chat, "两段自然分析，不需要新增图表").maxFindings, 2);
  const hybrid = routeTask(chat, "比较收入和现金流", { sourceMode: "hybrid" });
  assert.equal(hybrid.intent, "research");
  assert.equal(allowsTool(hybrid, "getIncomeStatements"), true);
  const revision = routeTask(chat, "修改收入章节", { mode: "revision" });
  assert.equal(revision.intent, "revision");
  assert.equal(allowsTool(revision, "deliverResearch"), false);
  assert.equal(allowsTool(revision, "proposeReportRevision"), true);
  const external = routeTask(chat, "市盈率多少", { sourceMode: "external" });
  assert.equal(external.intent, "lookup");
  assert.equal(allowsTool(external, "analyzeDocuments"), false);
});
