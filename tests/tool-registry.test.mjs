import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, modelTool } from "../server/tools/tool-registry.mjs";
import {
  researchToolCatalog,
  createResearchToolCatalog,
} from "../server/tools/catalog.mjs";
import { runAgentLoop } from "../server/agent/loop.mjs";
const definition = (name, extra = {}) => ({
  name,
  description: "测试工具 " + name,
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  },
  category: "data",
  load: async () => async (args) => args,
  ...extra,
});

test("registry discovers detached schemas and contracts without loading implementations", () => {
  let loads = 0;
  const entry = definition("lookup", {
    preconditions: ["company.identifier"],
    produces: ["source.external"],
    load: async () => {
      loads++;
      return async () => 1;
    },
  });
  const registry = new ToolRegistry({ entries: [entry] });
  entry.description = "外部改写";
  const listed = registry.list();
  assert.equal(loads, 0);
  assert.equal(listed[0].description, "测试工具 lookup");
  assert.deepEqual(listed[0].preconditions, ["company.identifier"]);
  assert.equal("load" in listed[0], false);
  listed[0].parameters.properties.query.type = "number";
  assert.equal(registry.list()[0].parameters.properties.query.type, "string");
  assert.equal("category" in modelTool(registry.list()[0]).function, false);
  assert.throws(() => registry.register(definition("lookup")), /重复注册/);
  assert.throws(() => registry.register({ name: "bad" }), /注册项/);
});

test("category and source permissions guard direct invocation as well as discovery", async () => {
  let loads = 0;
  const load = async () => {
    loads++;
    return async () => 1;
  };
  const registry = new ToolRegistry({
    entries: [
      definition("publicData", { sourceModes: ["external", "hybrid"], load }),
      definition("documentData", {
        sourceModes: ["documents", "hybrid"],
        load,
      }),
      definition("riskCheck", { category: "risk", load }),
    ],
    policy: { sourceMode: "documents", categories: ["data"] },
  });
  assert.deepEqual(
    registry.list().map((e) => e.name),
    ["documentData"],
  );
  assert.deepEqual(registry.list({ categories: ["risk"] }), []);
  await assert.rejects(() => registry.invoke("publicData"), /禁止外部/);
  await assert.rejects(() => registry.invoke("riskCheck"), /不提供/);
  await assert.rejects(() => registry.invoke("unknown"), /未注册/);
  assert.equal(loads, 0);
  assert.equal(await registry.invoke("documentData"), 1);
  assert.equal(loads, 1);
});

test("lazy loaders initialize once under concurrency and retry after loading failure", async () => {
  let loads = 0;
  const registry = new ToolRegistry({
    entries: [
      definition("lazy", {
        load: async () => {
          loads++;
          if (loads === 1) throw new Error("暂时加载失败");
          await Promise.resolve();
          return async (a) => a.query;
        },
      }),
    ],
  });
  await assert.rejects(() => registry.invoke("lazy"), /加载失败/);
  const values = await Promise.all([
    registry.invoke("lazy", { query: "a" }),
    registry.invoke("lazy", { query: "b" }),
  ]);
  assert.deepEqual(values, ["a", "b"]);
  assert.equal(loads, 2);
});

test("handler errors do not poison subsequent invocations and runtime contexts remain isolated", async () => {
  const entry = definition("contextTool", {
    load: async (ctx) => {
      let calls = 0;
      return async () => {
        if (++calls === 1) throw new Error("数据失败");
        return ctx.runId;
      };
    },
  });
  const first = new ToolRegistry({
      entries: [entry],
      context: { runId: "one" },
    }),
    second = new ToolRegistry({ entries: [entry], context: { runId: "two" } });
  await assert.rejects(() => first.invoke("contextTool"));
  assert.equal(await first.invoke("contextTool"), "one");
  await assert.rejects(() => second.invoke("contextTool"));
  assert.equal(await second.invoke("contextTool"), "two");
});

test("a newly registered tool runs in the unchanged agent loop without a prompt/name branch", async () => {
  const registry = new ToolRegistry({
    entries: [
      definition("complete", {
        category: "delivery",
        terminal: true,
        load: async () => async () => ({ done: true, summary: "完成" }),
      }),
    ],
  });
  let invoked = 0;
  registry.register(
    definition("newResearchCapability", {
      category: "analysis",
      load: async () => async () => {
        invoked++;
        return { value: 42 };
      },
    }),
  );
  let turns = 0;
  const schemas = registry.list().map(modelTool);
  const finish = modelTool(registry.list().find((e) => e.terminal));
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "处理任务" }],
    llm: async (messages) => {
      if (turns++ === 1)
        assert.equal(JSON.parse(messages.at(-1).content).value, 42);
      return {
        tool_calls: [
          {
            id: "call-" + turns,
            function: {
              name: turns === 1 ? "newResearchCapability" : "complete",
              arguments: "{}",
            },
          },
        ],
      };
    },
    tools: {
      schemas,
      finish,
      execute: (name, args) => registry.invoke(name, args),
    },
    memory: { observe() {}, checkpoint() {}, compact() {} },
  });
  assert.equal(invoked, 1);
  assert.equal(result.steps, 2);
  assert.equal(result.result.summary, "完成");
});

test("application catalog preserves tool inventory and revision/report-only scopes", () => {
  assert.deepEqual(
    researchToolCatalog.map((e) => e.name).sort(),
    [
      "getStockPrices",
      "getIncomeStatements",
      "getFinancialMetrics",
      "getCompanyFilings",
      "findCompany",
      "searchFilings",
      "readPage",
      "analyzeDocuments",
      "buildOperatingWorksheet",
      "calculate",
      "chartFromFilings",
      "createChart",
      "createScenario",
      "planResearch",
      "updateResearchGap",
      "readCurrentReport",
      "proposeReportRevision",
      "deliverResearch",
    ].sort(),
  );
  const docs = new ToolRegistry({
    entries: researchToolCatalog,
    policy: { sourceMode: "documents", mode: "research" },
  }).list();
  assert.ok(!docs.some((e) => e.name === "getIncomeStatements"));
  assert.ok(docs.some((e) => e.name === "buildOperatingWorksheet"));
  assert.deepEqual(
    docs.filter((e) => e.terminal).map((e) => e.name),
    ["deliverResearch"],
  );
  const revision = new ToolRegistry({
    entries: researchToolCatalog,
    policy: { sourceMode: "external", mode: "revision" },
  }).list();
  assert.deepEqual(
    revision.filter((e) => e.terminal).map((e) => e.name),
    ["proposeReportRevision"],
  );
  assert.ok(revision.some((e) => e.name === "readCurrentReport"));
  assert.ok(!revision.some((e) => e.name === "analyzeDocuments"));
  assert.ok(
    researchToolCatalog.every(
      (e) =>
        e.category &&
        Array.isArray(e.preconditions) &&
        Array.isArray(e.produces),
    ),
  );
  const configured = createResearchToolCatalog({
    run: { route: { maxFindings: 2 } },
  });
  assert.equal(
    configured.find((e) => e.name === "deliverResearch").parameters.properties
      .findings.maxItems,
    2,
  );
  assert.equal(
    researchToolCatalog.find((e) => e.name === "deliverResearch").parameters
      .properties.findings.maxItems,
    5,
  );
});

test("importing and listing the catalog does not initialize storage or load business modules", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yanji-catalog-"));
  try {
    const uri = new URL("../server/tools/catalog.mjs", import.meta.url).href;
    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m=await import(${JSON.stringify(uri)});process.stdout.write(String(m.researchToolCatalog.length));`,
      ],
      {
        env: {
          ...process.env,
          CHAT_DATA_DIR: path.join(dir, "must-not-exist"),
          CHAT_NO_INHERIT: "1",
        },
        encoding: "utf8",
      },
    );
    assert.equal(stdout, "18");
    assert.equal(fs.existsSync(path.join(dir, "must-not-exist")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
