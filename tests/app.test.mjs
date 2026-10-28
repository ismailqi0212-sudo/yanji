import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
process.env.CHAT_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "yanji-chat-"),
);
process.env.CHAT_NO_INHERIT = "1";
const { app } = await import("../server/index.mjs");
const store = await import("../server/memory/store.mjs");
const { FinancialToolsManager } =
  await import("../server/upstream/financial-tools.mjs");
const { scenarioResult } = await import("../server/research/artifacts.mjs");
const { model } = await import("../server/llm/client.mjs");
const financials = {
  success: true,
  result: {
    data: [
      {
        SECUCODE: "09899.HK",
        SECURITY_NAME_ABBR: "隔离测试",
        REPORT_DATE: "2023-12-31",
        CURRENCY: "HKD",
        OPERATE_INCOME: 100,
        GROSS_PROFIT: 20,
        HOLDER_PROFIT: 10,
        GROSS_PROFIT_RATIO: 20,
        ROE_AVG: 10,
      },
      {
        SECUCODE: "09899.HK",
        SECURITY_NAME_ABBR: "隔离测试",
        REPORT_DATE: "2024-12-31",
        CURRENCY: "HKD",
        OPERATE_INCOME: 120,
        GROSS_PROFIT: 30,
        HOLDER_PROFIT: 15,
        GROSS_PROFIT_RATIO: 25,
        ROE_AVG: 12,
      },
    ],
  },
};
const currencies = {
  result: {
    data: [
      {
        REPORT_LIST: financials.result.data.map((r) => ({
          ...r,
          CURRENCY: "人民币",
          REPORT_TYPE: "年报",
        })),
      },
    ],
  },
};
let invalidReport = false,
  forceDeliveryRepair = false;
const provider = http.createServer(async (req, res) => {
  let text = "";
  for await (const x of req) text += x;
  const input = JSON.parse(text),
    calls = input.messages.filter((m) => m.role === "tool");
  let name, args;
  if (
    forceDeliveryRepair &&
    input.tool_choice?.function?.name === "deliverResearch"
  ) {
    name = "deliverResearch";
    args = {
      summary: "校验后保留缺口",
      findings: [],
      gaps: ["需要原文核实原因"],
    };
  } else if (input.tool_choice?.function?.name === "analyzeDocuments") {
    name = "analyzeDocuments";
    args = { focus: "分析上传报告" };
  } else if (input.tool_choice?.function?.name === "analyzeDocumentPart") {
    const data = JSON.parse(input.messages.at(-1).content),
      source = data.sources[0];
    name = "analyzeDocumentPart";
    args = {
      findings: [
        {
          topic: "材料核对",
          text: "上传材料含收入披露，现金流仍需核对。",
          quote: source.text.slice(0, 25),
          sourceId: source.id,
        },
      ],
      metrics: [],
    };
  } else if (input.tool_choice?.function?.name === "writeReport") {
    const data =
        input.messages
          .map((m) => {
            try {
              return JSON.parse(m.content);
            } catch {
              return {};
            }
          })
          .find((x) => x.selected) || {},
      source = data.selected?.flatMap((c) => c.sourceIds)[0] || "unknown";
    name = "writeReport";
    args = {
      title: "根据已选内容生成的研报",
      sections: [
        {
          title: "核心判断",
          content: `收入[120元](evidence:${invalidReport ? "invented" : source})，仅基于用户选择的内容。`,
        },
      ],
    };
  } else if (
    input.tools?.some((t) => t.function.name === "proposeReportRevision")
  ) {
    if (!calls.some((c) => c.name === "readCurrentReport")) {
      name = "readCurrentReport";
      args = {};
    } else if (!calls.some((c) => c.name === "searchFilings")) {
      name = "searchFilings";
      args = { query: "收入" };
    } else {
      const report = JSON.parse(
          calls.find((c) => c.name === "readCurrentReport").content,
        ),
        sources = JSON.parse(
          calls.find((c) => c.name === "searchFilings").content,
        );
      name = "proposeReportRevision";
      args = {
        sectionId: report.sections[0].id,
        title: "补查后的判断",
        content: "补查材料说明收入120万元，仍需核对现金流。",
        reason: "已检索新上传材料，保留未解决的现金流缺口。",
        sourceIds: [sources[0].sourceId],
        remainingGaps: ["经营现金流尚未核实"],
      };
    }
  } else if (!input.tools) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }),
    );
    return;
  } else if (calls.length === 0) {
    name = "getIncomeStatements";
    args = { ticker: "hk09899", years: 3 };
  } else {
    const first = JSON.parse(calls[0].content);
    if (calls.length === 1) {
      name = "calculate";
      args = {
        operation: "growth",
        values: [120, 100],
        sourceIds: [first.sourceId],
      };
    } else if (calls.length === 2) {
      name = "createChart";
      args = { sourceId: first.sourceId, metric: "revenue", kind: "line" };
    } else if (calls.length === 3) {
      name = "createScenario";
      args = { sourceId: first.sourceId };
    } else {
      name = "deliverResearch";
      args = {
        summary: "已查询并整理为研究卡片。",
        findings: [
          {
            title: "收入与毛利率改善",
            kind: "fact",
            body: forceDeliveryRepair
              ? "收入增长[99.99%](evidence:C1)。"
              : "收入增长[20%](evidence:C1)。",
            sourceIds: ["C1"],
          },
        ],
        gaps: ["原因仍需原文核验"],
      };
    }
  }
  const arg = JSON.stringify(args);
  res.setHeader("Content-Type", "text/event-stream");
  const emit = (x) => res.write("data: " + JSON.stringify(x) + "\n\n");
  emit({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call" + calls.length,
              type: "function",
              function: { name, arguments: arg.slice(0, 20) },
            },
          ],
        },
      },
    ],
  });
  emit({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: arg.slice(20) } }],
        },
      },
    ],
  });
  emit({ choices: [], usage: { total_tokens: 10 } });
  res.end("data: [DONE]\n\n");
});
provider.listen(0, "127.0.0.1");
await new Promise((r) => provider.once("listening", r));
store.saveSettings({
  baseUrl: `http://127.0.0.1:${provider.address().port}`,
  model: "isolated-test-model",
  key: "fake-test-key",
});
const original = globalThis.fetch;
globalThis.fetch = (url, options) =>
  String(url).startsWith("https://datacenter.eastmoney.com/")
    ? Promise.resolve({
        ok: true,
        json: async () =>
          String(url).includes("RPT_CUSTOM_") ? currencies : financials,
      })
    : original(url, options);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
async function request(url, method = "GET", body) {
  const r = await fetch(base + url, {
    method,
    headers: {
      "x-yanji-client": "1",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
test.after(() => {
  server.close();
  provider.close();
  globalThis.fetch = original;
  store.db.close();
  fs.rmSync(process.env.CHAT_DATA_DIR, { recursive: true, force: true });
});
test("upstream financial tool manager executes once per query and retries failed calls", async () => {
  let n = 0;
  const manager = new FinancialToolsManager({
    getIncomeStatements: async () => ++n,
  });
  assert.equal(
    await manager.execute("getIncomeStatements", { ticker: "hk09899" }),
    1,
  );
  await assert.rejects(() =>
    manager.execute("getIncomeStatements", { ticker: "hk09899" }),
  );
  assert.equal(n, 1);
});
test("SSE transport assembles fragmented tool arguments without exposing keys", async () => {
  const r = await model([{ role: "user", content: "测试" }], {
    tools: [
      {
        type: "function",
        function: {
          name: "getIncomeStatements",
          parameters: { type: "object" },
        },
      },
    ],
  });
  assert.equal(r.tool_calls[0].function.name, "getIncomeStatements");
  assert.equal(
    JSON.parse(r.tool_calls[0].function.arguments).ticker,
    "hk09899",
  );
  assert.equal(r.usage, 10);
  assert.equal("key" in store.publicSettings(), false);
});
test("chat research, financial UI, source cards, scenarios and report compilation form a real stateful flow", async () => {
  let c = (await request("/chats", "POST", {})).body;
  assert.equal(c.messages.length, 0);
  let r = await request(`/chats/${c.id}/messages`, "POST", {
    text: "比较年度财务，再生成图表和沙盘",
  });
  assert.equal(r.status, 200);
  for (let i = 0; i < 100; i++) {
    c = store.getProject(c.id);
    if (c.runs[0].status !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(c.runs[0].status, "completed", c.runs[0].error);
  assert.equal(c.cards.filter((x) => x.kind === "brief").length, 1);
  assert.ok(
    !c.cards.find((x) => x.kind === "brief").data.body.includes("evidence:C1"),
  );
  assert.equal(
    c.cards.find((x) => x.kind === "financials").data.rows[0].currency,
    "人民币",
  );
  assert.equal(c.documents.length, 0);
  assert.ok(c.runs[0].records.some((x) => x.name === "calculate"));
  const trace = await request(`/chats/${c.id}/runs/${c.runs[0].id}/trace`);
  assert.equal(trace.status, 200);
  assert.ok(trace.body.steps.length > 0);
  assert.ok(
    trace.body.steps.every((step) => step.rawDecision && step.durationMs >= 0),
  );
  assert.ok(
    trace.body.steps
      .flatMap((step) => step.calls)
      .some((call) => call.source.length > 0),
  );
  assert.equal(c.runs[0].termination.reason, "completed");
  assert.ok(
    c.runs[0].checkpoint.trajectory.some(
      (event) => event.type === "observation",
    ),
  );
  const source = c.researchSources[0];
  r = await request(`/chats/${c.id}/sources/${source.id}`);
  assert.equal(r.body.type, "web");
  assert.equal(r.body.data.rows[1].revenue, 120);
  const pub = (await request(`/chats/${c.id}`)).body;
  assert.equal("text" in pub.researchSources[0], false);
  for (const card of c.cards.filter((x) => x.kind !== "gaps")) {
    c = (
      await request(`/chats/${c.id}/cards/${card.id}`, "PATCH", {
        revision: c.revision,
        selected: true,
      })
    ).body;
  }
  r = await request(`/chats/${c.id}/compile`, "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  c = r.body;
  assert.equal(c.report.version, 1);
  assert.equal(c.report.artifacts.length, 3);
  const scenario = c.cards.find((x) => x.kind === "scenario"),
    before = c.report.artifacts.find((x) => x.id === scenario.id).data.rows[0]
      .revenue;
  r = await request(`/chats/${c.id}/cards/${scenario.id}`, "PATCH", {
    revision: c.revision,
    input: { baseRevenue: 120, growth: 10, margin: 30, years: 2 },
  });
  assert.equal(r.status, 200);
  c = r.body;
  assert.equal(c.report.stale, true);
  assert.equal(
    c.cards.find((x) => x.id === scenario.id).data.rows[0].revenue,
    132,
  );
  assert.equal(
    c.report.artifacts.find((x) => x.id === scenario.id).data.rows[0].revenue,
    before,
  );
  const version = c.report.version;
  invalidReport = true;
  r = await request(`/chats/${c.id}/compile`, "POST", {});
  assert.equal(r.status, 400);
  assert.equal(store.getProject(c.id).report.version, version);
  invalidReport = false;
  r = await request(`/chats/${c.id}/cards/${scenario.id}`, "PATCH", {
    revision: c.revision - 1,
    notes: "过期编辑",
  });
  assert.equal(r.status, 409);
  const exported = await fetch(base + `/chats/${c.id}/export`);
  assert.match(await exported.text(), /来源/);
});
test("scenario calculation rejects invalid ranges and handles negative growth deterministically", () => {
  assert.equal(
    scenarioResult({ baseRevenue: 100, growth: -10, margin: 20, years: 1 })[0]
      .revenue,
    90,
  );
  assert.throws(() =>
    scenarioResult({ baseRevenue: 100, growth: -100, margin: 20, years: 2 }),
  );
  assert.throws(() =>
    scenarioResult({
      baseRevenue: 100,
      growth: 10,
      margin: Infinity,
      years: 2,
    }),
  );
});
test("uploaded sources stay isolated between chats and cross-origin writes fail", async () => {
  const a = store.createChat(),
    b = store.createChat();
  const form = new FormData();
  form.append(
    "file",
    new Blob([
      "2024年度营业收入120万元，2023年度营业收入100万元。本材料用于来源定位测试，不代表实际公司。",
    ]),
    "source.txt",
  );
  let r = await fetch(base + `/chats/${a.id}/documents`, {
    method: "POST",
    headers: { "x-yanji-client": "1" },
    body: form,
  });
  assert.equal(r.status, 200);
  const c = store.getProject(a.id),
    eid = c.documents[0].chunks[0].id;
  const pageResponse = await request(
    `/chats/${a.id}/documents/${c.documents[0].id}/page/1`,
  );
  const page = pageResponse.body;
  assert.equal(page.documentId, c.documents[0].id);
  assert.equal(page.type, c.documents[0].type);
  assert.equal(page.name, c.documents[0].name);
  assert.equal(
    (await request(`/chats/${b.id}/documents/${c.documents[0].id}/page/1`))
      .status,
    404,
  );
  assert.equal(
    (await request(`/chats/${a.id}/sources/${encodeURIComponent(eid)}`)).status,
    200,
  );
  assert.equal(
    (await request(`/chats/${b.id}/sources/${encodeURIComponent(eid)}`)).status,
    404,
  );
  r = await fetch(base + "/chats", {
    method: "POST",
    headers: { "x-yanji-client": "1", origin: "https://untrusted.example" },
  });
  assert.equal(r.status, 403);
});
test("research findings with valid source IDs can bind a whole-card citation when prose omits inline links", async () => {
  const { validateAnswer } = await import("../server/research/validation.mjs");
  const c = store
    .listChats()
    .find((x) => x.cards.some((c) => c.kind === "financials"));
  const sid = c.researchSources[0].id;
  const body = "历史数据支持收入改善。 " + `[依据](evidence:${sid})`;
  assert.ok(
    validateAnswer(c, { answer: body, sourceIds: [sid] }, new Set([sid])),
  );
});
test("report chart extraction rejects invented points and duplicate periods while keeping missing values", async () => {
  const { validateSeries } =
    await import("../server/tools/documents/material-chart.mjs");
  const chunks = [
    {
      id: "p1",
      name: "年报",
      text: "2023年收入1,200，2024年收入1,500，单位人民币千元",
    },
  ];
  const data = {
    title: "年度收入",
    unit: "人民币千元",
    scope: "年度合并",
    rows: [
      { period: "2023", value: 1200, rawValue: "1,200", sourceId: "p1" },
      { period: "2024", value: null, rawValue: "", sourceId: "p1" },
    ],
  };
  assert.equal(validateSeries(data, chunks).rows[1].value, null);
  assert.throws(() =>
    validateSeries(
      {
        ...data,
        rows: [
          { period: "2024", value: 1800, rawValue: "1,800", sourceId: "p1" },
        ],
      },
      chunks,
    ),
  );
  assert.throws(() =>
    validateSeries(
      {
        ...data,
        rows: [
          {
            period: "2024",
            value: 1500,
            rawValue: "1,500",
            sourceId: "invented",
          },
        ],
      },
      chunks,
    ),
  );
});
test("rapid independent card selections merge rather than discarding the second choice", async () => {
  const c = store.listChats().find((x) => x.cards.length > 2),
    cards = c.cards.slice(0, 2);
  const results = await Promise.all(
    cards.map((card) =>
      request(`/chats/${c.id}/cards/${card.id}`, "PATCH", {
        revision: c.revision,
        selected: true,
      }),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  const latest = store.getProject(c.id);
  assert.ok(
    cards.every((card) => latest.cards.find((x) => x.id === card.id).selected),
  );
});
test("SEC annual facts exclude quarterly values, preserve missing fields, and expose filing lineage", async () => {
  const { parseSEC } =
    await import("../server/tools/financial/global-financials.mjs");
  const point = (val, start = "2023-01-01", extra = {}) => ({
    val,
    start,
    end: "2023-12-31",
    filed: "2024-02-01",
    accn: "filing-1",
    form: "10-K",
    ...extra,
  });
  const raw = {
    cik: 1,
    entityName: "隔离测试",
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [point(100), point(30, "2023-10-01", { form: "10-Q" })],
          },
        },
        GrossProfit: { units: { USD: [point(40)] } },
        Assets: {
          units: {
            USD: [
              {
                val: 200,
                end: "2023-12-31",
                filed: "2024-02-01",
                form: "10-K",
              },
            ],
          },
        },
      },
    },
  };
  const d = parseSEC(raw, "usTEST", 3);
  assert.equal(d.rows[0].revenue, 100);
  assert.equal(d.rows[0].grossMargin, 40);
  assert.equal(d.rows[0].operatingCashFlow, null);
  assert.equal(d.rows[0].totalAssets, 200);
  assert.equal(d.rows[0].lineage.revenue.accession, "filing-1");
});
test("A-share parser retains cumulative period labels and refuses another security", async () => {
  const { parseA } =
    await import("../server/tools/financial/global-financials.mjs");
  const raw = {
    success: true,
    result: {
      data: [
        {
          SECUCODE: "002027.SZ",
          SECURITY_NAME_ABBR: "测试",
          REPORT_DATE: "2025-06-30",
          REPORT_TYPE: "中报",
          OPERATE_INCOME_PK: 100,
          XSMLL: 40,
          NETCASH_OPERATE_PK: 50,
        },
      ],
    },
  };
  const d = parseA(raw, "sz002027", "latest");
  assert.equal(d.rows[0].reportType, "中报");
  assert.equal(d.rows[0].grossProfit, null);
  assert.equal(d.rows[0].operatingCashFlow, 50);
  assert.throws(() => parseA(raw, "sz000001"));
});
test("financial comparisons calculate cash conversion and changes without treating cumulative data as annual", async () => {
  const { financialComparisons } =
    await import("../server/research/comparisons.mjs");
  const card = {
    kind: "financials",
    sourceIds: ["S1"],
    data: {
      rows: [
        {
          period: "2023",
          revenue: 100,
          attributableProfit: 10,
          operatingCashFlow: 20,
          netMargin: 10,
        },
        {
          period: "2024",
          revenue: 120,
          attributableProfit: 20,
          operatingCashFlow: 18,
          netMargin: 16,
        },
      ],
    },
  };
  const result = financialComparisons([card]);
  assert.equal(
    result.find((x) => x.operation === "ratio" && x.period === "2024").result,
    0.9,
  );
  assert.ok(
    result.some(
      (x) => x.metric === "operatingCashFlow" && Math.abs(x.result + 10) < 1e-8,
    ),
  );
  assert.ok(result.some((x) => x.metric === "netMargin" && x.result === 6));
  assert.equal(
    financialComparisons([
      { ...card, data: { ...card.data, frequency: "latest" } },
    ]).length,
    0,
  );
});
test("chapter research uses read/tool/observe loops and requires confirmation before changing the report", async () => {
  let c = store.listChats().find((c) => c.report);
  const before = c.report.sections[0].content,
    version = c.report.version;
  const form = new FormData();
  form.append(
    "file",
    new Blob([
      "补查材料：2024年度收入120万元，经营现金流尚未提供。这是隔离测试文本，不代表实际公司。",
    ]),
    "revision-source.txt",
  );
  assert.equal(
    (
      await fetch(base + `/chats/${c.id}/documents`, {
        method: "POST",
        headers: { "x-yanji-client": "1" },
        body: form,
      })
    ).status,
    200,
  );
  const start = await request(`/chats/${c.id}/report/research`, "POST", {
    sectionId: c.report.sections[0].id,
    instruction: "补查收入，保留现金流缺口并修改本节",
  });
  assert.equal(start.status, 200);
  for (let i = 0; i < 100; i++) {
    c = store.getProject(c.id);
    if (c.runs.at(-1).status !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(c.runs.at(-1).status, "completed", c.runs.at(-1).error);
  assert.equal(c.runs.at(-1).stage, "awaiting_confirmation");
  assert.equal(c.report.sections[0].content, before);
  assert.equal(c.report.version, version);
  assert.deepEqual(
    c.runs.at(-1).records.map((r) => r.name),
    [
      "analyzeDocuments",
      "readCurrentReport",
      "searchFilings",
      "proposeReportRevision",
    ],
  );
  assert.ok(c.runs.at(-1).checkpoint.messages.some((m) => m.role === "tool"));
  const pub = (await request(`/chats/${c.id}`)).body;
  assert.equal("checkpoint" in pub.runs.at(-1), false);
  assert.ok(pub.runs.at(-1).memory.observedSources > 0);
  const proposal = c.cards.find((card) => card.kind === "revision");
  assert.equal(proposal.data.status, "pending");
  let accepted = await request(
    `/chats/${c.id}/revisions/${proposal.id}/accept`,
    "POST",
    {},
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.report.version, version + 1);
  assert.match(accepted.body.report.sections[0].content, /补查材料/);
  assert.equal(accepted.body.reports.at(-1).sections[0].content, before);
  assert.equal(
    (
      await request(
        `/chats/${c.id}/revisions/${proposal.id}/accept`,
        "POST",
        {},
      )
    ).status,
    400,
  );
});
test("a pending revision refuses to overwrite a newer report version", async () => {
  const { proposeRevision } = await import("../server/reports/revisions.mjs");
  let c = store.listChats().find((c) => c.report),
    sourceId = c.report.sourceIds[0];
  const run = {
    id: "revision-conflict",
    messageId: "revision-message",
    sectionId: c.report.sections[0].id,
    baseReportVersion: c.report.version,
    records: [],
    events: [],
  };
  c.runs.push(run);
  c.messages.push({
    id: run.messageId,
    role: "assistant",
    text: "",
    cardIds: [],
  });
  store.putProject(c);
  proposeRevision(
    { cid: c.id, run, seen: new Set([sourceId]), calculations: [] },
    {
      sectionId: run.sectionId,
      title: "条件性结论",
      content: "现有证据仍不足以判断原因。",
      reason: "保留不确定性",
      sourceIds: [sourceId],
      remainingGaps: [],
    },
  );
  c = store.getProject(c.id);
  const card = c.cards.filter((c) => c.kind === "revision").at(-1);
  c.report.version++;
  store.putProject(c);
  assert.equal(
    (await request(`/chats/${c.id}/revisions/${card.id}/accept`, "POST", {}))
      .status,
    409,
  );
});
test("research gaps persist with the project and cannot be marked answered without read evidence", async () => {
  const { savePlan, updateGap } = await import("../server/research/plan.mjs");
  const c = store.listChats().find((c) => c.report),
    sourceId = c.report.sourceIds[0];
  const plan = savePlan(c.id, c.runs[0].id, {
    goal: "验证现金流与利润是否同步",
    steps: ["核对报表", "比较口径"],
    gaps: [{ question: "缺少什么现金流依据？", dimension: "deep_dive" }],
  });
  assert.throws(() =>
    updateGap(
      c.id,
      {
        gapId: plan.gaps[0].id,
        status: "answered",
        sourceIds: [],
        note: "完成",
      },
      new Set(),
    ),
  );
  updateGap(
    c.id,
    {
      gapId: plan.gaps[0].id,
      status: "answered",
      sourceIds: [sourceId],
      note: "已补充底稿，因果尚待确认",
    },
    new Set([sourceId]),
  );
  assert.equal(store.getProject(c.id).researchPlan.gaps[0].status, "answered");
});
test("uploaded-document mode reads long text first and blocks external financial providers", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  let c = store.listChats().find((c) => c.documents.length);
  const run = {
    id: "document-policy",
    messageId: "document-policy-message",
    question: "研究上传报告",
    sourceMode: "documents",
    events: [],
    records: [],
    usage: 0,
  };
  c.runs.push(run);
  c.messages.push({
    id: run.messageId,
    role: "assistant",
    text: "",
    cardIds: [],
  });
  store.putProject(c);
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(),
    calculations: [],
  });
  assert.equal(tools.requiredFirst.function.name, "analyzeDocuments");
  await assert.rejects(
    () => tools.execute("getIncomeStatements", { ticker: "hk09899" }),
    /禁止外部/,
  );
  await assert.rejects(
    () => tools.execute("getCompanyFilings", { ticker: "002027" }),
    /不查询外部/,
  );
});
test("long-document batching covers every chunk, rejects fabricated quotes, and preserves raw units", async () => {
  const { documentBatches, validatePart } =
    await import("../server/tools/documents/long-analysis.mjs");
  const chunks = [
    {
      id: "p1",
      documentId: "d1",
      page: 1,
      text: "2023年度合并收入1,200人民币千元。毛利率20%。",
    },
    {
      id: "p2",
      documentId: "d1",
      page: 2,
      text: "现金流尚需核实，不能据收入判断现金创造能力。",
    },
  ];
  assert.deepEqual(
    documentBatches(chunks, 35)
      .flat()
      .map((c) => c.id),
    ["p1", "p2"],
  );
  const result = validatePart(
    {
      findings: [
        {
          topic: "收入",
          text: "收入披露",
          quote: "2023年度合并收入1,200人民币千元",
          sourceId: "p1",
        },
        {
          topic: "伪造",
          text: "不可信",
          quote: "公司经营现金流大幅增加",
          sourceId: "p2",
        },
      ],
      metrics: [
        {
          metric: "revenue",
          period: "2023",
          value: 1200,
          rawValue: "1,200",
          unit: "人民币千元",
          currency: "人民币",
          scope: "年度合并",
          sourceId: "p1",
        },
        {
          metric: "revenue",
          period: "2023",
          value: 1800,
          rawValue: "1,800",
          unit: "人民币千元",
          scope: "年度合并",
          sourceId: "p1",
        },
      ],
    },
    chunks,
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.metrics.length, 1);
  assert.equal(result.metrics[0].unit, "人民币千元");
  assert.equal(result.rejected.length, 2);
});
test("document-only memory excludes previous external financial answers", async () => {
  const { buildContext, initialWorkingMemory } =
    await import("../server/memory/context.mjs");
  const c = {
    documents: [
      { id: "d", name: "报告", pages: [{}], chunks: [{ id: "doc:1:0" }] },
    ],
    messages: [
      { role: "assistant", text: "外部收入999999", cardIds: ["external"] },
      { role: "user", text: "新问题", cardIds: [] },
      { role: "assistant", text: "", cardIds: [] },
    ],
    cards: [
      {
        id: "external",
        kind: "financials",
        title: "外部",
        data: { rows: [{ revenue: 999999 }] },
        sourceIds: ["S-external"],
        selected: true,
      },
    ],
    runs: [],
    report: null,
  };
  const run = { sourceMode: "documents", question: "仅看上传报告" };
  assert.ok(!JSON.stringify(buildContext(c, run, "system")).includes("999999"));
  assert.equal(initialWorkingMemory(c, run).seen.has("S-external"), false);
});
test("validated PDF percentage metrics support parenthesized negatives without trusting uncited metrics", async () => {
  const { validateAnswer } = await import("../server/research/validation.mjs");
  const c = store.listChats().find((c) => c.documents.length),
    source = c.documents[0].chunks[0];
  c.documentAnalysisCache = {
    sample: {
      metrics: [
        { metric: "grossMargin", value: -12.2, unit: "%", sourceId: source.id },
        {
          metric: "grossMargin",
          value: 99.9,
          unit: "%",
          sourceId: "other-document",
        },
      ],
    },
  };
  assert.ok(
    validateAnswer(
      c,
      {
        answer: `毛利率为[-12.2%](evidence:${source.id})。`,
        sourceIds: [source.id],
      },
      new Set([source.id]),
    ),
  );
  assert.throws(() =>
    validateAnswer(
      c,
      {
        answer: `毛利率为[99.9%](evidence:${source.id})。`,
        sourceIds: [source.id],
      },
      new Set([source.id]),
    ),
  );
});
test("PDF percentage columns retain parentheses and cost-ratio magnitude conventions", async () => {
  const { pdfTablePercentages } =
    await import("../server/research/validation.mjs");
  const values = pdfTablePercentages(
    "人民幣 % 人民幣 %（千元，百分比除外）\n營業成本 (6,854,948) (98.0) (5,491,066) (112.2)\n毛利 (595,335) (12.2)",
  );
  assert.ok(values.includes(-12.2));
  assert.ok(values.includes(-112.2));
  assert.ok(values.includes(112.2));
  assert.equal(pdfTablePercentages("没有百分比表头的收入123 99.9").length, 0);
});

test("routed tools hide forbidden sources and reject excess sections before saving", async () => {
  const { routeTask } = await import("../server/agent/router.mjs");
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const c = store.createChat();
  const run = {
    id: "route-check",
    question: "两段自然分析，不需要图表",
    mode: "research",
    sourceMode: "documents",
    route: routeTask(c, "两段自然分析，不需要图表", {
      sourceMode: "documents",
    }),
  };
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(),
    calculations: [],
  });
  assert.equal(
    tools.schemas.some((s) => s.function.name === "getIncomeStatements"),
    false,
  );
  assert.equal(
    tools.finish.function.parameters.properties.findings.maxItems,
    2,
  );
  await assert.rejects(
    () => tools.execute("getIncomeStatements", { ticker: "AAPL" }),
    /当前研究任务/,
  );
  await assert.rejects(
    () =>
      tools.execute("deliverResearch", {
        summary: "test",
        findings: [{}, {}, {}],
        gaps: [],
      }),
    /最多2段/,
  );
  assert.equal(store.getProject(c.id).cards.length, 0);
});

test("task skills are allowlisted and operating data uses the worksheet as its real entry tool", async () => {
  const { getResearchSkill } = await import("../server/skills/catalog.mjs");
  const { routeTask } = await import("../server/agent/router.mjs");
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  assert.throws(() => getResearchSkill("../../etc/passwd"), /不支持/);
  assert.throws(
    () =>
      routeTask({ documents: [] }, "整理底稿", {
        skillId: "operating-metrics",
      }),
    /先上传/,
  );
  const c = store.listChats().find((c) => c.documents.length);
  const route = routeTask(c, "整理经营底稿", {
    skillId: "operating-metrics",
  });
  assert.equal(route.sourceMode, "documents");
  const tools = createResearchTools({
    cid: c.id,
    run: { sourceMode: route.sourceMode, route },
    seen: new Set(),
    calculations: [],
  });
  assert.equal(tools.requiredFirst.function.name, "buildOperatingWorksheet");
  assert.equal(
    tools.schemas.some((t) => t.function.name === "getIncomeStatements"),
    false,
  );
});
test("operating extraction rejects fabricated quotes and numbers while retaining raw units", async () => {
  const { validateOperatingFacts } =
    await import("../server/tools/documents/operating-worksheet.mjs");
  const source = {
    id: "s1",
    documentId: "d1",
    page: 5,
    text: "2024年度 订阅业务收入为1,200百万元，月活跃用户数为30百万人。",
  };
  const candidate = {
    company: "example",
    metric: "订阅业务收入",
    period: "2024",
    kind: "flow",
    value: 1200,
    rawValue: "1,200",
    unit: "百万元",
    currency: "CNY",
    scope: "合并",
    calendar: "12月",
    sourceId: "s1",
    quote: source.text,
  };
  const r = validateOperatingFacts(
    {
      facts: [
        candidate,
        { ...candidate, value: 999 },
        { ...candidate, quote: "2024年度 订阅业务收入为999百万元。" },
      ],
    },
    [source],
  );
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].value, 1200);
  assert.equal(r.facts[0].unit, "百万元");
  assert.equal(r.facts[0].page, 5);
  assert.equal(r.rejected.length, 2);
});

test("operating worksheet persists sourced values and reuses this run instead of rereading on rephrasing", async () => {
  const { buildOperatingWorksheet } =
    await import("../server/tools/documents/operating-worksheet.mjs");
  const { recordObservation } = await import("../server/memory/run-state.mjs");
  const c = store.createChat(),
    doc = store
      .listChats()
      .find((c) => c.documents.some((d) => d.name === "source.txt"))
      .documents.find((d) => d.name === "source.txt");
  c.documents = [doc];
  const run = {
    id: "worksheet-test",
    messageId: "worksheet-message",
    question: "整理收入底稿",
    records: [],
    events: [],
    usage: 0,
  };
  c.runs = [run];
  c.messages = [
    { id: run.messageId, role: "assistant", text: "", cardIds: [] },
  ];
  store.putProject(c);
  let calls = 0;
  const source = doc.chunks[0];
  const llm = async () => {
    calls++;
    return {
      usage: 10,
      tool_calls: [
        {
          id: "extract",
          function: {
            name: "extractOperatingFacts",
            arguments: JSON.stringify({
              facts: [
                {
                  company: "example",
                  metric: "营业收入",
                  period: "2024",
                  kind: "flow",
                  value: 120,
                  rawValue: "120",
                  unit: "万元",
                  currency: "CNY",
                  scope: "合并",
                  calendar: "12月",
                  sourceId: source.id,
                  quote: source.text,
                },
              ],
            }),
          },
        },
      ],
    };
  };
  const ctx = {
    cid: c.id,
    run,
    seen: new Set(),
    signal: new AbortController().signal,
  };
  const result = await buildOperatingWorksheet(ctx, { focus: "整理收入" }, llm);
  assert.equal(
    store.getProject(c.id).cards[0].data.rows[0].cells["2024"].value,
    120,
  );
  assert.equal(ctx.seen.has(source.id), true);
  recordObservation(
    c.id,
    run.id,
    {
      id: "host",
      function: { name: "buildOperatingWorksheet", arguments: "{}" },
    },
    result,
  );
  const reused = await buildOperatingWorksheet(
    ctx,
    { focus: "换一种说法再整理同一批数据" },
    llm,
  );
  assert.equal(reused.reused, true);
  assert.equal(calls, 1);
  assert.equal(store.getProject(c.id).cards.length, 1);
  const chart = await request(
    `/chats/${c.id}/cards/${result.cardId}/chart`,
    "POST",
    { revision: store.getProject(c.id).revision, metric: "metric-0:annual" },
  );
  assert.equal(chart.status, 200);
  const artifact = chart.body.cards.find((c) => c.kind === "chart");
  assert.equal(artifact.data.rows[0].value, 120);
  const { exportMarkdown } = await import("../server/reports/export.mjs");
  const project = store.getProject(c.id);
  project.report = {
    version: 1,
    at: "test",
    sections: [],
    artifacts: [project.cards[0]],
    sourceIds: [source.id],
    title: "底稿导出",
  };
  assert.match(exportMarkdown(project), /营业收入/);
  assert.match(exportMarkdown(project), /120/);
});

test("archiving hides a conversation without deleting research and restore returns the same content", async () => {
  const c = store.createChat();
  c.title = "archive-check";
  c.messages = [
    { id: "saved-message", role: "user", text: "保留原问题", cardIds: [] },
  ];
  store.putProject(c);
  let r = await request(`/chats/${c.id}`, "PATCH", {
    archived: true,
    title: "已归档研究",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.archived, true);
  assert.equal(
    (await request("/chats")).body.some((x) => x.id === c.id),
    false,
  );
  assert.equal(
    (await request("/chats?includeArchived=1")).body.some((x) => x.id === c.id),
    true,
  );
  assert.equal(
    (await request(`/chats/${c.id}`)).body.messages[0].text,
    "保留原问题",
  );
  r = await request(`/chats/${c.id}`, "PATCH", { archived: false });
  assert.equal(r.body.archived, false);
  assert.equal(r.body.title, "已归档研究");
  assert.equal(
    (await request("/chats")).body.some((x) => x.id === c.id),
    true,
  );
});

test("scenario tool honors explicit growth and horizon rather than historical defaults", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const c = store.createChat();
  c.researchSources.push({
    id: "scenario-base",
    type: "financials",
    name: "年度财务",
    data: {
      name: "测试公司",
      frequency: "annual",
      rows: [
        { period: "2023", revenue: 100, grossMargin: 20, currency: "CNY" },
        { period: "2024", revenue: 120, grossMargin: 25, currency: "CNY" },
      ],
    },
  });
  const run = {
    id: "explicit-scenario",
    messageId: "scenario-message",
    question: "明年增长5%",
    status: "running",
    events: [],
  };
  c.messages.push({
    id: "scenario-message",
    role: "assistant",
    text: "",
    cardIds: [],
  });
  c.runs.push(run);
  store.putProject(c);
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(["scenario-base"]),
    calculations: [],
  });
  await tools.execute("createScenario", {
    sourceId: "scenario-base",
    growth: 5,
    margin: 30,
    years: 1,
  });
  const data = store
    .getProject(c.id)
    .cards.find((x) => x.kind === "scenario").data;
  assert.equal(data.input.growth, 5);
  assert.equal(data.input.margin, 30);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].revenue, 126);
  assert.equal(data.rows[0].grossProfit, 37.8);
});

test("report findings retain financial comparisons without selecting their table", async () => {
  const { reportComputations } = await import("../server/reports/writer.mjs");
  const { reviewDraft } = await import("../server/reports/reviewer.mjs");
  const c = store.createChat(),
    sid = "S-report-profit";
  const data = {
    frequency: "annual",
    rows: [
      { period: "2020", attributableProfit: 57411 },
      { period: "2021", attributableProfit: 94680 },
    ],
  };
  c.researchSources.push({
    id: sid,
    type: "web",
    name: "财务",
    data,
    text: JSON.stringify(data),
  });
  const brief = {
    kind: "brief",
    selected: true,
    sourceIds: [sid],
    data: { body: "利润同比增长" },
  };
  c.cards.push(brief);
  c.runs.push({
    records: [
      {
        name: "calculate",
        result: { operation: "growth", result: 999, sourceIds: ["unselected"] },
      },
    ],
  });
  const computed = reportComputations(c, [brief], [sid]);
  assert.ok(computed.some((x) => x.display === "64.92%"));
  assert.equal(
    computed.some((x) => x.result === 999),
    false,
  );
  assert.equal(
    c.cards.some((x) => x.kind === "financials"),
    false,
  );
  reviewDraft(
    c,
    {
      sections: [
        {
          title: "盈利变化",
          content: `净利润同比+64.92%[来源](evidence:${sid})`,
        },
      ],
    },
    [sid],
    computed,
  );
  assert.throws(
    () =>
      reviewDraft(
        c,
        {
          sections: [
            {
              title: "错误",
              content: `净利润同比+65.92%[来源](evidence:${sid})`,
            },
          ],
        },
        [sid],
        computed,
      ),
    /未匹配/,
  );
});

test("percentage validation cannot borrow calculations from unrelated evidence", async () => {
  const { reviewDraft } = await import("../server/reports/reviewer.mjs");
  const c = store.createChat(),
    sid = "S-current-source";
  c.researchSources.push({
    id: sid,
    type: "web",
    name: "当前资料",
    text: "{}",
    data: {},
  });
  const draft = {
    sections: [{ title: "增长", content: `增长64.92%[来源](evidence:${sid})` }],
  };
  assert.throws(
    () =>
      reviewDraft(
        c,
        draft,
        [sid],
        [{ operation: "growth", result: 64.92, sourceIds: ["S-unrelated"] }],
      ),
    /未匹配/,
  );
  reviewDraft(
    c,
    draft,
    [sid],
    [{ operation: "growth", result: 64.92, sourceIds: [sid] }],
  );
});

test("report reviewer checks numeric claims in headings as well as paragraphs", async () => {
  const { reviewDraft } = await import("../server/reports/reviewer.mjs");
  const c = store.createChat(),
    sid = "S-heading";
  c.researchSources.push({
    id: sid,
    type: "web",
    name: "财务",
    text: "{}",
    data: {},
  });
  assert.throws(
    () =>
      reviewDraft(
        c,
        {
          sections: [
            { title: "收入增长99%", content: `详情[来源](evidence:${sid})` },
          ],
        },
        [sid],
        [],
      ),
    /未匹配/,
  );
});

test("bounded delivery repair records both failed and successful model rounds through SessionStore", async () => {
  const { repairDelivery } =
    await import("../server/agent/repair-delivery.mjs");
  const { sessionStore } = await import("../server/trace/runtime-store.mjs");
  const c = store.createChat(),
    rid = "repair-trace",
    mid = "repair-message";
  c.messages.push({ id: mid, role: "assistant", text: "", cardIds: [] });
  c.runs.push({
    id: rid,
    messageId: mid,
    status: "running",
    round: 9,
    usage: 0,
    events: [],
    records: [
      {
        name: "deliverResearch",
        args: JSON.stringify({ findings: [] }),
        result: { error: "测试校验失败" },
      },
    ],
  });
  store.putProject(c);
  let attempts = 0;
  await repairDelivery({
    cid: c.id,
    run: c.runs[0],
    seen: new Set(),
    calculations: [],
    tools: {
      execute: async () =>
        ++attempts === 1
          ? { error: "仍需修复" }
          : { done: true, summary: "已修复" },
    },
    llm: async () => ({
      content: "",
      usage: 7,
      tool_calls: [
        {
          id: "repair-" + attempts,
          function: {
            name: "deliverResearch",
            arguments: JSON.stringify({ findings: [] }),
          },
        },
      ],
    }),
  });
  const trace = sessionStore.readTrace(c.id, rid);
  assert.equal(trace.steps.length, 2);
  assert.ok(trace.steps.every((s) => s.phase === "repair" && s.rawDecision));
  assert.equal(trace.steps[0].calls[0].observation.status, "error");
  assert.equal(trace.steps[1].status, "completed");
  assert.equal(store.getProject(c.id).runs[0].termination.reason, "completed");
});

function stagedTestRun() {
  const c = store.createChat();
  const run = {
    id: store.id(),
    messageId: store.id(),
    question: "检查提交边界",
    status: "running",
    mode: "research",
    sourceMode: "external",
    records: [],
    events: [],
    usage: 0,
  };
  c.runs.push(run);
  c.messages.push({
    id: run.messageId,
    role: "assistant",
    text: "",
    cardIds: [],
  });
  const source = {
    id: "S-stage-base",
    type: "web",
    name: "年度财务",
    text: "{}",
    data: {
      name: "测试公司",
      frequency: "annual",
      rows: [
        { period: "2023", revenue: 100, grossMargin: 20, currency: "CNY" },
        { period: "2024", revenue: 120, grossMargin: 25, currency: "CNY" },
      ],
    },
  };
  c.researchSources.push(source);
  store.putProject(c);
  return { c, run };
}

test("verifier rejection leaves no scenario artifact, source or seen-memory; acceptance then commits once", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { sessionStore } = await import("../server/trace/runtime-store.mjs");
  const { c, run } = stagedTestRun();
  const seen = new Set(["S-stage-base"]),
    calculations = [];
  let accept = false;
  const verifier = {
    verify: async (observation) => {
      assert.equal(observation.pendingArtifacts.length, 1);
      assert.equal(store.getProject(c.id).cards.length, 0);
      assert.equal(store.getProject(c.id).researchSources.length, 1);
      assert.equal(seen.size, 1);
      assert.ok(observation.sources.some((s) => s.id === "S-stage-base"));
      return { accepted: accept, reason: "测试拒绝" };
    },
  };
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen,
    calculations,
    verifier,
  });
  await assert.rejects(
    () =>
      tools.invoke(
        "createScenario",
        { sourceId: "S-stage-base", growth: 5, years: 1 },
        { callId: "reject-scenario" },
      ),
    /测试拒绝/,
  );
  let saved = store.getProject(c.id);
  assert.equal(saved.cards.length, 0);
  assert.equal(saved.researchSources.length, 1);
  assert.equal(saved.messages[0].cardIds.length, 0);
  assert.equal(seen.size, 1);
  const trace = sessionStore.readTrace(c.id, run.id);
  assert.ok(
    trace.events.some(
      (e) =>
        e.kind === "tool_verification" &&
        e.body.status === "rejected" &&
        e.body.uncommittedSourceIds.length === 1,
    ),
  );
  accept = true;
  const result = await tools.invoke("createScenario", {
    sourceId: "S-stage-base",
    growth: 5,
    years: 1,
  });
  saved = store.getProject(c.id);
  assert.equal(saved.cards.length, 1);
  assert.equal(saved.researchSources.length, 2);
  assert.equal(saved.messages[0].cardIds[0], result.cardId);
  assert.ok(result.sourceIds.every((id) => seen.has(id)));
});

test("rejected calculations do not enter working memory", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  const calculations = [];
  let accept = false;
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(["S-stage-base"]),
    calculations,
    verifier: {
      verify: async () => ({ accepted: accept, reason: "不接受计算" }),
    },
  });
  const args = {
    operation: "growth",
    values: [120, 100],
    sourceIds: ["S-stage-base"],
  };
  await assert.rejects(() => tools.execute("calculate", args), /不接受/);
  assert.equal(calculations.length, 0);
  accept = true;
  await tools.execute("calculate", args);
  assert.equal(calculations.length, 1);
  assert.equal(calculations[0].id, "C1");
});

test("rejecting financial data does not poison query retry/dedup or publish unverified rows", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  let accept = false;
  const seen = new Set();
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen,
    calculations: [],
    verifier: {
      verify: async () => ({ accepted: accept, reason: "取数暂不接受" }),
    },
  });
  const args = { ticker: "hk09899" };
  await assert.rejects(
    () => tools.execute("getIncomeStatements", args),
    /暂不接受/,
  );
  assert.equal(store.getProject(c.id).cards.length, 0);
  assert.equal(store.getProject(c.id).researchSources.length, 1);
  assert.equal(seen.size, 0);
  accept = true;
  await tools.execute("getIncomeStatements", args);
  assert.equal(store.getProject(c.id).cards.length, 1);
  assert.ok(seen.size > 0);
  await assert.rejects(
    () => tools.execute("getIncomeStatements", args),
    /已经查询/,
  );
});

test("concurrent user edits are preserved and conflicting candidate writes are rejected atomically", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  const seen = new Set(["S-stage-base"]);
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen,
    calculations: [],
    verifier: {
      verify: async () => {
        const latest = store.getProject(c.id);
        latest.cards.push({
          id: "user-card",
          kind: "brief",
          selected: true,
          sourceIds: [],
          data: { body: "用户修改" },
        });
        store.putProject(latest);
        return { accepted: true };
      },
    },
  });
  await assert.rejects(
    () => tools.execute("createScenario", { sourceId: "S-stage-base" }),
    /内容已变化/,
  );
  const saved = store.getProject(c.id);
  assert.deepEqual(
    saved.cards.map((c) => c.id),
    ["user-card"],
  );
  assert.equal(saved.researchSources.length, 1);
  assert.equal(saved.messages[0].cardIds.length, 0);
  assert.equal(seen.size, 1);
});

test("cancellation during verifier prevents committing an otherwise valid result", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  const controller = new AbortController();
  const seen = new Set(["S-stage-base"]);
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen,
    calculations: [],
    signal: controller.signal,
    verifier: {
      verify: async () => {
        controller.abort();
        return { accepted: true };
      },
    },
  });
  await assert.rejects(() =>
    tools.execute("createScenario", { sourceId: "S-stage-base" }),
  );
  assert.equal(store.getProject(c.id).cards.length, 0);
  assert.equal(store.getProject(c.id).researchSources.length, 1);
  assert.equal(seen.size, 1);
});

test("rejected document analysis retains usage/progress but publishes no cache, document card or seen evidence", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  run.sourceMode = "documents";
  const text = "2024年度合并收入为100百万元，经营现金流尚需核对。";
  c.runs[0] = run;
  c.documents = [
    {
      id: "stage-doc",
      name: "财报.txt",
      hash: "stage-hash",
      warnings: [],
      pages: [text],
      chunks: [
        {
          id: "D-stage",
          documentId: "stage-doc",
          name: "财报.txt",
          page: 1,
          text,
        },
      ],
    },
  ];
  store.putProject(c);
  const seen = new Set();
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen,
    calculations: [],
    verifier: {
      verify: async () => ({ accepted: false, reason: "文档结果需复核" }),
    },
  });
  await assert.rejects(
    () => tools.execute("analyzeDocuments", { focus: "收入" }),
    /需复核/,
  );
  const saved = store.getProject(c.id);
  assert.equal(saved.cards.length, 0);
  assert.equal(saved.documentAnalysisCache, undefined);
  assert.equal(seen.size, 0);
  assert.equal(saved.messages[0].cardIds.length, 0);
  assert.ok(saved.runs[0].documentProgress.length > 0);
});

test("rejected report proposal does not create a pending revision or gaps, and cannot change the report", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  Object.assign(run, {
    mode: "revision",
    baseReportVersion: 1,
    sectionId: "section",
  });
  c.runs[0] = run;
  c.report = {
    id: "report",
    title: "报告",
    version: 1,
    sections: [{ id: "section", title: "现金流", content: "原稿" }],
    sourceIds: ["S-stage-base"],
    cardVersions: {},
    artifacts: [],
  };
  store.putProject(c);
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(["S-stage-base"]),
    calculations: [],
    verifier: {
      verify: async () => ({ accepted: false, reason: "修改不接受" }),
    },
  });
  await assert.rejects(
    () =>
      tools.execute("proposeReportRevision", {
        sectionId: "section",
        title: "现金流核对",
        content: "现金流仍需补查[来源](evidence:S-stage-base)",
        reason: "补查",
        sourceIds: ["S-stage-base"],
        remainingGaps: ["资本开支缺失"],
      }),
    /不接受/,
  );
  const saved = store.getProject(c.id);
  assert.equal(saved.cards.length, 0);
  assert.equal(saved.researchPlan, undefined);
  assert.equal(saved.report.version, 1);
  assert.equal(saved.report.sections[0].content, "原稿");
});

test("business writes roll back if their acceptance audit cannot be persisted", async () => {
  const { sessionStore } = await import("../server/trace/runtime-store.mjs");
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  const original = sessionStore.recordToolVerification;
  sessionStore.recordToolVerification = function (cid, rid, payload) {
    if (payload.status === "accepted") throw new Error("模拟轨迹写入失败");
    return original.call(this, cid, rid, payload);
  };
  try {
    const tools = createResearchTools({
      cid: c.id,
      run,
      seen: new Set(["S-stage-base"]),
      calculations: [],
    });
    await assert.rejects(
      () => tools.execute("createScenario", { sourceId: "S-stage-base" }),
      /轨迹写入失败/,
    );
    const saved = store.getProject(c.id);
    assert.equal(saved.cards.length, 0);
    assert.equal(saved.researchSources.length, 1);
    assert.equal(saved.messages[0].cardIds.length, 0);
  } finally {
    sessionStore.recordToolVerification = original;
  }
});

test("concurrent invocations in one runtime preserve distinct calculation IDs and working memory", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { c, run } = stagedTestRun();
  const calculations = [];
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(["S-stage-base"]),
    calculations,
  });
  await Promise.all([
    tools.execute("calculate", {
      operation: "sum",
      values: [1, 2],
      sourceIds: ["S-stage-base"],
    }),
    tools.execute("calculate", {
      operation: "sum",
      values: [3, 4],
      sourceIds: ["S-stage-base"],
    }),
  ]);
  assert.deepEqual(
    calculations.map((c) => c.id),
    ["C1", "C2"],
  );
  assert.deepEqual(
    calculations.map((c) => c.result),
    [3, 7],
  );
});

test("loop observes verifier rejection as rejected trace data and can finish with explicit gaps", async () => {
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { runAgentLoop } = await import("../server/agent/loop.mjs");
  const { traceForRun, sessionStore } =
    await import("../server/trace/runtime-store.mjs");
  const { c, run } = stagedTestRun();
  const seen = new Set(["S-stage-base"]);
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen,
    calculations: [],
    verifier: {
      verify: async (observation) => ({
        accepted: observation.toolName !== "createScenario",
        reason: "测算需核实",
      }),
    },
  });
  let turns = 0;
  const out = await runAgentLoop({
    messages: [{ role: "user", content: "测算" }],
    tools,
    trace: traceForRun(c.id, run.id),
    llm: async (messages) => {
      if (++turns === 2) {
        const feedback = JSON.parse(messages.at(-1).content);
        assert.equal(feedback.status, "rejected");
        assert.equal(feedback.code, "VERIFICATION_REJECTED");
      }
      return {
        tool_calls: [
          {
            id: "step5-" + turns,
            function: {
              name: turns === 1 ? "createScenario" : "deliverResearch",
              arguments: JSON.stringify(
                turns === 1
                  ? { sourceId: "S-stage-base", growth: 5 }
                  : {
                      summary: "暂时不能确认测算",
                      findings: [],
                      gaps: ["测算需人工核对"],
                    },
              ),
            },
          },
        ],
      };
    },
    memory: {
      observe: (call, result, metadata) =>
        sessionStore.commitObservation(c.id, run.id, call, result, metadata),
      checkpoint() {},
    },
  });
  assert.equal(out.steps, 2);
  const saved = store.getProject(c.id);
  assert.equal(
    saved.cards.some((card) => card.kind === "scenario"),
    false,
  );
  assert.equal(saved.cards.filter((card) => card.kind === "gaps").length, 1);
  assert.equal(saved.researchSources.length, 1);
  assert.equal(seen.size, 1);
  assert.equal(
    sessionStore.readTrace(c.id, run.id).steps[0].calls[0].observation.status,
    "rejected",
  );
});

test("structured finish in production mode still passes through staged deterministic delivery validation", async () => {
  const { AgentLoop } = await import("../server/agent/agent-loop.mjs");
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { traceForRun, sessionStore } =
    await import("../server/trace/runtime-store.mjs");
  const { ContextAssembler } =
    await import("../server/context/context-assembler.mjs");
  const { c, run } = stagedTestRun();
  const tools = createResearchTools({
    cid: c.id,
    run,
    seen: new Set(["S-stage-base"]),
    calculations: [],
  });
  let turns = 0;
  const loop = new AgentLoop({
    registry: tools,
    assembler: new ContextAssembler({
      baseMessages: [{ role: "user", content: "研究" }],
      toolRegistry: tools,
    }),
    trace: traceForRun(c.id, run.id),
    errorFeedback: tools.errorFeedback,
    llm: async () => ({
      content: JSON.stringify({
        type: "finish",
        summary: "完成",
        output:
          ++turns === 1
            ? {
                summary: "错误初稿",
                findings: [
                  {
                    title: "收入",
                    body: "增长99.99%[来源](evidence:S-stage-base)",
                    sourceIds: ["S-stage-base"],
                    kind: "fact",
                  },
                ],
                gaps: [],
              }
            : { summary: "资料不足", findings: [], gaps: ["需要补充证据"] },
      }),
    }),
    memory: {
      observe: (...a) => sessionStore.commitObservation(c.id, run.id, ...a),
      checkpoint() {},
    },
  });
  const out = await loop.run({
    state: { sessionId: c.id, runId: run.id, task: { goal: "研究" } },
    requireTerminal: true,
    maxSteps: 2,
  });
  assert.equal(out.reason, "completed");
  assert.equal(turns, 2);
  const saved = store.getProject(c.id);
  assert.equal(saved.cards.filter((c) => c.kind === "brief").length, 0);
  assert.equal(saved.cards.filter((c) => c.kind === "gaps").length, 1);
  const trace = sessionStore.readTrace(c.id, run.id);
  assert.equal(trace.steps[0].calls[0].observation.status, "error");
  assert.equal(JSON.parse(trace.steps[0].rawDecision.content).type, "finish");
});

test("HTTP research switches to bounded terminal-only recovery through the unified loop", async () => {
  const { sessionStore } = await import("../server/trace/runtime-store.mjs");
  const c = (await request("/chats", "POST", {})).body;
  forceDeliveryRepair = true;
  try {
    const r = await request(`/chats/${c.id}/messages`, "POST", {
      text: "比较年度财务并核对结果",
    });
    assert.equal(r.status, 200);
    let saved;
    for (let i = 0; i < 200; i++) {
      saved = store.getProject(c.id);
      if (saved.runs[0].status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const run = saved.runs[0];
    assert.equal(run.status, "completed", run.error);
    assert.equal(run.recoveredAfterValidation, true);
    assert.equal(run.termination.recoveredAfterValidation, true);
    assert.ok(run.termination.steps <= 11);
    assert.equal(
      saved.cards.some((card) => card.kind === "brief"),
      false,
    );
    assert.ok(saved.cards.some((card) => card.kind === "gaps"));
    const repairs = sessionStore
      .readTrace(c.id, run.id)
      .steps.filter((s) => s.phase === "repair");
    assert.equal(repairs.length, 1);
    assert.ok(
      repairs
        .flatMap((s) => s.calls)
        .every((call) => call.name === "deliverResearch"),
    );
    assert.equal(saved.messages.at(-1).text, "校验后保留缺口");
  } finally {
    forceDeliveryRepair = false;
  }
});

function reportFixture() {
  const c = store.createChat(),
    sid = "report-step7";
  c.researchSources.push({
    id: sid,
    type: "web",
    name: "已确认财务",
    text: "收入120元",
    data: { frequency: "annual", rows: [{ period: "2024", revenue: 120 }] },
  });
  c.cards.push({
    id: "confirmed",
    version: 1,
    kind: "brief",
    title: "收入",
    selected: true,
    sourceIds: [sid],
    data: { body: "收入120元" },
  });
  store.putProject(c);
  return c;
}
function reportResponse(content, usage = 11) {
  return {
    usage,
    tool_calls: [
      {
        id: "report-call",
        function: {
          name: "writeReport",
          arguments: JSON.stringify({
            title: "研究",
            sections: [{ title: "经营表现", content }],
          }),
        },
      },
    ],
  };
}
test("report validation feeds the next unified-loop round and records all model usage without fabricating messages", async () => {
  const { compileReport } = await import("../server/reports/writer.mjs");
  const { sessionStore } = await import("../server/trace/runtime-store.mjs");
  const c = reportFixture();
  let turns = 0;
  const result = await compileReport(c.id, "brief", {
    transport: async (messages) => {
      turns++;
      if (turns === 2)
        assert.match(
          messages.findLast((m) => m.role === "tool").content,
          /未确认来源/,
        );
      return reportResponse(
        `收入[120元](evidence:${turns === 1 ? "invented" : "report-step7"})`,
      );
    },
  });
  assert.equal(result.report.version, 1);
  assert.equal(result.messages.length, 0);
  const run = result.runs.at(-1),
    trace = sessionStore.readTrace(c.id, run.id);
  assert.equal(run.mode, "report");
  assert.equal(run.status, "completed");
  assert.equal(trace.steps.length, 2);
  assert.equal(trace.modelCalls.length, 2);
  assert.equal(run.usage, 22);
  assert.equal(trace.steps[0].calls[0].observation.status, "error");
  assert.equal(trace.steps[1].calls[0].source[0].id, "report-step7");
});
test("a selection changed while report IO is running cannot be overwritten", async () => {
  const { compileReport } = await import("../server/reports/writer.mjs");
  const c = reportFixture();
  await assert.rejects(
    compileReport(c.id, "brief", {
      transport: async () => {
        const latest = store.getProject(c.id);
        latest.cards[0].selected = false;
        store.putProject(latest);
        return reportResponse("收入[120元](evidence:report-step7)");
      },
    }),
    /所选内容已变化/,
  );
  const saved = store.getProject(c.id);
  assert.equal(saved.report, null);
  assert.equal(saved.cards[0].selected, false);
  assert.equal(saved.runs.at(-1).status, "failed");
});
test("report cancellation interrupts model IO and never accepts a late draft", async () => {
  const { compileReport } = await import("../server/reports/writer.mjs");
  const { stop } = await import("../server/agent/research-agent.mjs");
  const { sessionStore } = await import("../server/trace/runtime-store.mjs");
  const c = reportFixture();
  let release;
  const promise = compileReport(c.id, "brief", {
    transport: async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await new Promise((r) => setImmediate(r));
  const runId = store.getProject(c.id).runs.at(-1).id;
  stop(c.id, runId);
  await assert.rejects(promise, /停止/);
  release(reportResponse("收入[120元](evidence:report-step7)"));
  await new Promise((r) => setImmediate(r));
  const saved = store.getProject(c.id);
  assert.equal(saved.report, null);
  assert.equal(saved.reportJob.status, "cancelled");
  assert.equal(saved.runs.at(-1).status, "cancelled");
  assert.equal(
    sessionStore.readTrace(c.id, runId).modelCalls[0].status,
    "cancelled",
  );
});
test("section editing returns a traced proposal and leaves the accepted report unchanged", async () => {
  const { compileReport, reviseSection } =
    await import("../server/reports/writer.mjs");
  const c = reportFixture(),
    transport = async () =>
      reportResponse("收入[120元](evidence:report-step7)");
  await compileReport(c.id, "brief", { transport });
  const before = store.getProject(c.id).report;
  const proposal = await reviseSection(
    c.id,
    before.sections[0].id,
    "简洁一点",
    { transport },
  );
  assert.equal(proposal.baseVersion, 1);
  assert.ok(proposal.content);
  assert.deepEqual(store.getProject(c.id).report, before);
  assert.equal(store.getProject(c.id).runs.at(-1).mode, "section-edit");
  const accepted = await request(`/chats/${c.id}/report`, "PATCH", {
    revision: store.getProject(c.id).revision,
    version: proposal.baseVersion,
    sectionId: proposal.sectionId,
    content: proposal.content,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.report.version, 2);
  assert.equal(accepted.body.reports.at(-1).version, 1);
  const exported = await fetch(base + `/chats/${c.id}/export`);
  assert.match(await exported.text(), /120/);
});
test("report verifier rejection never creates a report version", async () => {
  const { compileReport } = await import("../server/reports/writer.mjs");
  const c = reportFixture();
  await assert.rejects(
    compileReport(c.id, "brief", {
      transport: async () =>
        reportResponse("收入[120元](evidence:report-step7)"),
      verifier: {
        verify: async () => ({ accepted: false, reason: "拒绝候选稿" }),
      },
    }),
    /拒绝候选稿/,
  );
  assert.equal(store.getProject(c.id).report, null);
  assert.equal(store.getProject(c.id).runs.at(-1).usage, 22);
});

function smallPdf(text) {
  const stream = `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test("PDF to worksheet to chart to source-page to report and export preserves lineage and internal call accounting", async () => {
  const { AgentLoop } = await import("../server/agent/agent-loop.mjs");
  const { ContextAssembler } =
    await import("../server/context/context-assembler.mjs");
  const { runtimeModel } = await import("../server/llm/runtime-model.mjs");
  const { createResearchTools } = await import("../server/tools/registry.mjs");
  const { sessionStore, traceForRun } =
    await import("../server/trace/runtime-store.mjs");
  const { compileReport } = await import("../server/reports/writer.mjs");
  const c = store.createChat(),
    form = new FormData();
  form.append(
    "file",
    new Blob([smallPdf("2024 Revenue 120 CNY; 2023 Revenue 100 CNY.")], {
      type: "application/pdf",
    }),
    "annual.pdf",
  );
  const uploaded = await fetch(base + `/chats/${c.id}/documents`, {
    method: "POST",
    headers: { "x-yanji-client": "1" },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const doc = store.getProject(c.id).documents[0],
    source = doc.chunks[0];
  assert.match(source.text, /Revenue/);
  const run = {
    id: "pdf-step7",
    messageId: "pdf-answer",
    question: "整理营业收入",
    mode: "research",
    status: "running",
    sourceMode: "documents",
    route: { sourceMode: "documents", skillId: "operating-metrics" },
    records: [],
    events: [],
    usage: 0,
  };
  sessionStore.createRun(
    c.id,
    run,
    { id: "question", role: "user", text: run.question, cardIds: [] },
    { id: run.messageId, role: "assistant", text: "", cardIds: [] },
  );
  const controller = new AbortController();
  const service = runtimeModel(
    c.id,
    run.id,
    controller.signal,
    "agent-decision",
    async (_, options) => {
      const name = options.force;
      if (name === "extractOperatingFacts")
        return {
          usage: 10,
          tool_calls: [
            {
              id: "extract",
              function: {
                name,
                arguments: JSON.stringify({
                  facts: [2023, 2024].map((period) => ({
                    company: "Example",
                    metric: "营业收入",
                    period: String(period),
                    kind: "flow",
                    value: period === 2024 ? 120 : 100,
                    rawValue: period === 2024 ? "120" : "100",
                    unit: "元",
                    currency: "CNY",
                    scope: "合并",
                    calendar: "12月",
                    sourceId: source.id,
                    quote: source.text,
                  })),
                }),
              },
            },
          ],
        };
      if (name === "alignOperatingMetrics")
        return {
          usage: 5,
          tool_calls: [
            { id: "align", function: { name, arguments: '{"groups":[]}' } },
          ],
        };
      return {
        usage: 7,
        tool_calls: [
          {
            id: "finish",
            function: {
              name: "deliverResearch",
              arguments: JSON.stringify({
                summary: "已整理经营底稿",
                findings: [],
                gaps: ["需要补充利润披露"],
              }),
            },
          },
        ],
      };
    },
  );
  const tools = createResearchTools({
    cid: c.id,
    run,
    signal: controller.signal,
    modelService: service,
    seen: new Set(),
    calculations: [],
  });
  const loop = new AgentLoop({
    registry: tools,
    assembler: new ContextAssembler({
      baseMessages: [{ role: "user", content: run.question }],
      toolRegistry: tools,
    }),
    llm: (messages, options) => service.complete(messages, options),
    trace: traceForRun(c.id, run.id),
    memory: {
      observe: (call, result, metadata) =>
        sessionStore.commitObservation(c.id, run.id, call, result, metadata),
    },
  });
  const outcome = await loop.run({
    state: { sessionId: c.id, runId: run.id, task: { goal: run.question } },
    initialActions: [
      {
        id: "worksheet-call",
        name: "buildOperatingWorksheet",
        args: { focus: run.question },
      },
    ],
    maxSteps: 2,
    requireTerminal: true,
    signal: controller.signal,
  });
  assert.equal(outcome.reason, "completed", JSON.stringify(outcome));
  sessionStore.updateRun(c.id, run.id, (_, r) => {
    r.status = "completed";
  });
  const trace = sessionStore.readTrace(c.id, run.id);
  assert.equal(trace.modelCalls.length, 3);
  assert.equal(store.getProject(c.id).runs[0].usage, 22);
  assert.ok(
    trace.modelCalls
      .filter((c) => c.purpose !== "agent-decision")
      .every((c) => c.parentCallId === "worksheet-call"),
  );
  let saved = store.getProject(c.id),
    worksheet = saved.cards.find((c) => c.kind === "worksheet");
  assert.ok(worksheet, JSON.stringify(saved.runs[0].records));
  const metric = worksheet.data.rows[0].id;
  const chartResponse = await request(
    `/chats/${c.id}/cards/${worksheet.id}/chart`,
    "POST",
    { revision: saved.revision, metric },
  );
  assert.equal(chartResponse.status, 200, JSON.stringify(chartResponse.body));
  const page = await request(
    `/chats/${c.id}/sources/${encodeURIComponent(source.id)}`,
  );
  assert.equal(page.body.page, 1);
  assert.equal(page.body.documentId, doc.id);
  const pdf = await fetch(base + `/chats/${c.id}/documents/${doc.id}/file`);
  assert.equal(pdf.status, 200);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );
  saved = store.getProject(c.id);
  for (const card of saved.cards)
    if (["worksheet", "chart"].includes(card.kind)) card.selected = true;
  store.putProject(saved);
  await compileReport(c.id, "brief", {
    transport: async () => reportResponse(`收入[120元](evidence:${source.id})`),
  });
  const exported = await fetch(base + `/chats/${c.id}/export`);
  assert.match(await exported.text(), /120/);
  assert.equal(store.getProject(c.id).report.artifacts.length, 2);
});
