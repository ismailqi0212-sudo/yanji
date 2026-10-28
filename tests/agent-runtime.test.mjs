import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../server/agent/agent-loop.mjs";
import { AgentRuntimeFactory } from "../server/agent/runtime-factory.mjs";
import { parseDecision } from "../server/agent/decision-parser.mjs";
const descriptors = [
  {
    name: "lookup",
    description: "查询",
    parameters: { type: "object" },
    category: "data",
  },
  {
    name: "finish",
    description: "完成",
    parameters: { type: "object" },
    category: "delivery",
    terminal: true,
  },
];
const action = (name, args = {}) => ({
  tool_calls: [
    { id: "call-" + name, function: { name, arguments: JSON.stringify(args) } },
  ],
});
const state = () => ({
  runId: "run",
  sessionId: "session",
  task: { goal: "任务", sourceMode: "external" },
  trajectory: [],
});
const registry = (invoke) => ({
  list: () => structuredClone(descriptors),
  invoke,
});
const assembler = {
  build: async (state) => ({
    messages: [{ role: "user", content: JSON.stringify(state.trajectory) }],
    tools: [],
  }),
};

test("decision parser separates explicit finish, actions and invalid decisions without running tools", () => {
  assert.equal(parseDecision({ content: "完成了" }).kind, "invalid");
  assert.equal(parseDecision(null).kind, "invalid");
  assert.equal(parseDecision({ tool_calls: "invalid" }).kind, "invalid");
  assert.equal(
    parseDecision({
      content: JSON.stringify({ type: "finish", summary: "任务完成" }),
    }).kind,
    "finish",
  );
  const d = parseDecision({
    tool_calls: [
      { id: "a", function: { name: "lookup", arguments: '{"ticker":"AAPL"}' } },
      { id: "b", function: { name: "lookup", arguments: "null" } },
    ],
  });
  assert.equal(d.kind, "act");
  assert.equal(d.actions[0].args.ticker, "AAPL");
  assert.equal(d.actions[1].error.code, "INVALID_ARGUMENTS");
});

test("native loop returns structured completion while production-style finish requires a checked terminal tool", async () => {
  let calls = 0;
  const r = registry(async (name, args) => {
    calls++;
    assert.equal(name, "finish");
    assert.equal(args.summary, "有依据");
    return { done: true, summary: args.summary };
  });
  const bare = new AgentLoop({
    registry: r,
    assembler,
    llm: async () => ({ decision: { type: "finish", summary: "直接完成" } }),
  });
  const result = await bare.run({ state: state() });
  assert.equal(result.reason, "completed");
  assert.equal(calls, 0);
  const denied = await bare.run({
    state: state(),
    requireTerminal: true,
    maxSteps: 1,
  });
  assert.equal(denied.reason, "budget_exhausted");
  assert.equal(calls, 0);
  const validated = new AgentLoop({
    registry: r,
    assembler,
    llm: async () => ({
      content: JSON.stringify({
        type: "finish",
        summary: "完成",
        output: { summary: "有依据" },
      }),
    }),
  });
  const out = await validated.run({ state: state(), requireTerminal: true });
  assert.equal(out.reason, "completed");
  assert.equal(calls, 1);
  assert.equal(out.toolCalls, 1);
});

test("model and tool budgets are hard bounds, including terminal calls", async () => {
  let calls = 0;
  const loop = new AgentLoop({
    registry: registry(async () => {
      calls++;
      return { value: 1 };
    }),
    assembler,
    llm: async () => ({
      tool_calls: [
        ...action("lookup").tool_calls,
        ...action("finish").tool_calls,
      ],
    }),
  });
  const out = await loop.run({ state: state(), maxSteps: 2, maxToolCalls: 1 });
  assert.equal(out.reason, "budget_exhausted");
  assert.equal(out.steps, 2);
  assert.equal(out.toolCalls, 1);
  assert.equal(calls, 1);
});

test("preflight uses the same loop path and stores its failure before returning failed", async () => {
  const observed = [],
    checkpoints = [];
  let models = 0;
  const loop = new AgentLoop({
    registry: registry(async () => {
      throw new Error("材料不可读");
    }),
    assembler,
    llm: async () => {
      models++;
    },
    memory: {
      observe: (...a) => observed.push(a),
      checkpoint: (c) => checkpoints.push(c),
    },
  });
  const out = await loop.run({
    state: state(),
    initialActions: [{ name: "lookup", args: { query: "财报" } }],
  });
  assert.equal(out.reason, "failed");
  assert.match(out.error.message, /材料不可读/);
  assert.equal(models, 0);
  assert.equal(observed.length, 1);
  assert.equal(checkpoints[0].trajectory[0].type, "preflight");
});

test("bounded recovery changes configuration inside the same loop and cannot query nonterminal tools", async () => {
  let turns = 0,
    prepareCalls = 0,
    lookups = 0;
  const phases = [];
  const primary = registry(async (name) => {
    if (name === "lookup") lookups++;
    throw new Error("交付不合格");
  });
  const terminal = {
    list: () => [descriptors[1]],
    invoke: async (name) => {
      assert.equal(name, "finish");
      return { done: true, summary: "修复完成" };
    },
  };
  const loop = new AgentLoop({
    registry: primary,
    assembler,
    llm: async (messages, options) => {
      turns++;
      if (turns > 1) assert.equal(options.maxTokens, 5200);
      return action(turns === 2 ? "lookup" : "finish");
    },
    trace: {
      beginStep: (meta) => {
        phases.push(meta.phase);
        return { decision() {}, observation() {}, end() {} };
      },
    },
  });
  const out = await loop.run({
    state: state(),
    maxSteps: 1,
    maxToolCalls: 1,
    requireTerminal: true,
    recovery: {
      maxSteps: 2,
      maxToolCalls: 2,
      prepare: async () => {
        prepareCalls++;
        return {
          registry: terminal,
          assembler,
          llmOptions: { maxTokens: 5200 },
          maxSteps: 2,
          maxToolCalls: 2,
        };
      },
    },
  });
  assert.equal(out.reason, "completed");
  assert.equal(out.recovered, true);
  assert.equal(out.steps, 3);
  assert.equal(out.toolCalls, 2);
  assert.equal(lookups, 0);
  assert.equal(prepareCalls, 1);
  assert.deepEqual(phases, ["research", "repair", "repair"]);
});

test("recovery cannot widen registry capabilities or exceed declared limits", async () => {
  for (const config of [
    {
      registry: registry(async () => ({ done: true })),
      maxSteps: 1,
      maxToolCalls: 1,
    },
    {
      registry: { list: () => [descriptors[1]] },
      maxSteps: 3,
      maxToolCalls: 1,
    },
  ]) {
    const loop = new AgentLoop({
      registry: registry(async () => ({})),
      assembler,
      llm: async () => ({ content: "未完成" }),
    });
    const out = await loop.run({
      state: state(),
      maxSteps: 1,
      recovery: {
        maxSteps: 2,
        maxToolCalls: 2,
        prepare: async () => ({ ...config, assembler }),
      },
    });
    assert.equal(out.reason, "failed");
    assert.match(out.error.message, /恢复/);
  }
});

test("external abort returns before an uncooperative LLM resolves and ignores its late output", async () => {
  const controller = new AbortController();
  let release,
    start,
    lateText,
    tools = 0,
    texts = 0;
  const started = new Promise((r) => (start = r)),
    pending = new Promise((r) => (release = r));
  const loop = new AgentLoop({
    registry: registry(async () => {
      tools++;
      return { done: true };
    }),
    assembler,
    llm: async (messages, options) => {
      lateText = options.onText;
      start();
      return pending;
    },
    onText: () => texts++,
  });
  const task = loop.run({ state: state(), signal: controller.signal });
  await started;
  controller.abort();
  const out = await task;
  assert.equal(out.reason, "cancelled");
  lateText("迟到的文本");
  release(action("finish"));
  await Promise.resolve();
  assert.equal(tools, 0);
  assert.equal(texts, 0);
});

test("runtime factory isolates parent/child state and limits source, category, depth and count", async () => {
  const snapshots = new Map();
  const factory = new AgentRuntimeFactory({
    allowChildren: true,
    maxDepth: 1,
    maxChildren: 1,
    assemble: async (scope) => ({
      registry: registry(async () => ({ done: true })),
      assembler: {
        build: async (s) => {
          snapshots.set(scope.runId, structuredClone(s));
          s.task.goal = "不能泄漏";
          return { messages: [], tools: [] };
        },
      },
      llm: async () => ({ decision: { type: "finish", summary: scope.runId } }),
    }),
  });
  const parent = factory.create({
    sessionId: "session",
    runId: "parent",
    categories: ["data", "delivery"],
    sourceMode: "documents",
    maxSteps: 2,
    maxToolCalls: 2,
  });
  assert.throws(() => parent.createChild({ categories: ["risk"] }), /扩大/);
  assert.throws(() => parent.createChild({ sourceMode: "external" }), /扩大/);
  const child = parent.createChild({
    runId: "child",
    categories: ["delivery"],
    maxSteps: 1,
    maxToolCalls: 1,
  });
  assert.throws(() => child.createChild({}), /深度/);
  assert.throws(() => parent.createChild({}), /数量/);
  const c = await child.run({ task: { goal: "子任务" } }),
    p = await parent.run({ task: { goal: "主任务" } });
  assert.equal(c.parentRunId, "parent");
  assert.equal(p.parentRunId, undefined);
  assert.equal(c.steps, 1);
  assert.equal(p.steps, 1);
  assert.equal(snapshots.get("child").task.goal, "子任务");
  assert.equal(snapshots.get("parent").task.goal, "主任务");
  assert.deepEqual(snapshots.get("child").categories, ["delivery"]);
});

test("parent cancellation propagates into a child runtime without invoking a model", async () => {
  let models = 0;
  const factory = new AgentRuntimeFactory({
    allowChildren: true,
    assemble: async () => ({
      registry: registry(async () => ({})),
      assembler,
      llm: async () => {
        models++;
        return { decision: { type: "finish", summary: "完成" } };
      },
    }),
  });
  const parent = factory.create({ sessionId: "session", runId: "p" }),
    child = parent.createChild({ runId: "c" });
  parent.cancel();
  const out = await child.run({ task: { goal: "子任务" } });
  assert.equal(out.reason, "cancelled");
  assert.equal(models, 0);
});

test("child category restriction remains effective even if dependency assembly exposes broader tools", async () => {
  let dataCalls = 0,
    turns = 0;
  const factory = new AgentRuntimeFactory({
    allowChildren: true,
    assemble: async () => ({
      registry: registry(async () => {
        dataCalls++;
        return { done: true };
      }),
      assembler,
      llm: async () =>
        ++turns === 1
          ? action("lookup")
          : { decision: { type: "finish", summary: "保留缺口" } },
    }),
  });
  const parent = factory.create({ categories: ["data", "delivery"] });
  const child = parent.createChild({ categories: ["delivery"] });
  const out = await child.run({ task: { goal: "受限任务" } });
  assert.equal(out.reason, "completed");
  assert.equal(dataCalls, 0);
  assert.equal(turns, 2);
});
