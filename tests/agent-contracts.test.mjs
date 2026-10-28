/** Characterization tests: execute the unchanged runtime, not a replacement loop. */
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../server/agent/loop.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// context imports the legacy store, whose module initialization touches storage.
// Set isolation before the dynamic import, even though these tests use memory fixtures.
process.env.CHAT_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "yanji-contracts-"),
);
process.env.CHAT_NO_INHERIT = "1";
const { initialWorkingMemory, buildContext } =
  await import("../server/memory/context.mjs");

const schema = (name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
});
const action = (name) => ({
  tool_calls: [{ id: "call-1", function: { name, arguments: "{}" } }],
});
const memory = () => ({ observe() {}, checkpoint() {}, compact() {} });

test("step 6: mandatory ingestion failure rejects before LLM and persists an error observation", async () => {
  let llmCalls = 0,
    observed = 0,
    checkpoints = 0;
  await assert.rejects(
    () =>
      runAgentLoop({
        messages: [{ role: "user", content: "看财报" }],
        llm: async () => {
          llmCalls++;
        },
        tools: {
          requiredFirst: schema("ingest"),
          schemas: [schema("ingest"), schema("finish")],
          finish: schema("finish"),
          execute: async () => {
            throw new Error("PDF读取失败");
          },
        },
        memory: {
          observe() {
            observed++;
          },
          checkpoint() {
            checkpoints++;
          },
        },
      }),
    /PDF读取失败/,
  );
  assert.equal(llmCalls, 0);
  assert.equal(observed, 1);
  assert.equal(checkpoints, 1);
});

test("baseline: plain-text completion is not terminal and exhausts the step budget", async () => {
  const messages = [{ role: "user", content: "查询" }];
  let calls = 0,
    executions = 0,
    checkpoints = 0;
  await assert.rejects(
    () =>
      runAgentLoop({
        messages,
        maxSteps: 2,
        llm: async () => {
          calls++;
          return { content: "已完成" };
        },
        tools: {
          schemas: [schema("finish")],
          finish: schema("finish"),
          execute: async () => {
            executions++;
          },
        },
        memory: {
          ...memory(),
          checkpoint() {
            checkpoints++;
          },
        },
      }),
    /预算/,
  );
  assert.equal(calls, 2);
  assert.equal(executions, 0);
  assert.equal(checkpoints, 2);
  assert.match(messages.at(-1).content, /最后调用finish/);
});

test("step 6: cancellation discards a non-cooperative tool result and records cancellation", async () => {
  const controller = new AbortController();
  let turns = 0;
  const observed = [];
  await assert.rejects(() =>
    runAgentLoop({
      messages: [],
      signal: controller.signal,
      llm: async () => {
        turns++;
        return action("lookup");
      },
      tools: {
        schemas: [schema("lookup"), schema("finish")],
        finish: schema("finish"),
        execute: async () => {
          controller.abort();
          return { value: 1 };
        },
      },
      memory: {
        ...memory(),
        observe(call, result) {
          observed.push(result);
        },
      },
    }),
  );
  assert.equal(turns, 1);
  assert.equal(observed.length, 1);
  assert.match(observed[0].error, /abort|取消/i);
  assert.equal(observed[0].value, undefined);
});

test("baseline: an unavailable tool becomes an error observation and the next model turn can finish", async () => {
  let turns = 0;
  const observed = [];
  const out = await runAgentLoop({
    messages: [],
    llm: async (messages) => {
      if (++turns === 1)
        return {
          tool_calls: [
            { id: "bad", function: { name: "notRegistered", arguments: "{}" } },
          ],
        };
      assert.ok(JSON.parse(messages.at(-1).content).error);
      return action("finish");
    },
    tools: {
      schemas: [schema("lookup"), schema("finish")],
      finish: schema("finish"),
      execute: async (name) => {
        assert.equal(name, "finish");
        return { done: true, summary: "完成" };
      },
    },
    memory: {
      ...memory(),
      observe(call, result) {
        observed.push(result);
      },
    },
  });
  assert.equal(out.steps, 2);
  assert.equal(out.toolCalls, 1);
  assert.ok(observed[0].error);
});

test("baseline: report-only recall excludes external cards and their calculation memory", () => {
  const chat = {
    documents: [
      { id: "doc", name: "年报", pages: ["p"], chunks: [{ id: "D1" }] },
    ],
    researchSources: [{ id: "E1" }],
    cards: [
      {
        id: "local",
        kind: "brief",
        title: "报告发现",
        version: 1,
        selected: true,
        sourceIds: ["D1"],
        data: { body: "报告收入" },
      },
      {
        id: "outside",
        kind: "brief",
        title: "外部发现",
        version: 1,
        selected: true,
        sourceIds: ["E1"],
        data: { body: "外部秘密标记" },
      },
    ],
    messages: [
      { role: "user", text: "旧问题" },
      { role: "assistant", text: "外部秘密标记", cardIds: ["outside"] },
      { role: "user", text: "新问题" },
      { role: "assistant", text: "" },
    ],
    runs: [
      {
        records: [
          { name: "calculate", result: { result: 20, sourceIds: ["E1"] } },
          { name: "calculate", result: { result: 10, sourceIds: ["D1"] } },
        ],
      },
    ],
  };
  const run = { sourceMode: "documents", question: "仅按报告分析" };
  const working = initialWorkingMemory(chat, run);
  assert.deepEqual([...working.seen], ["D1"]);
  assert.deepEqual(
    working.calculations.map((c) => c.result),
    [10],
  );
  const messages = buildContext(chat, run, "系统约束");
  assert.doesNotMatch(JSON.stringify(messages), /外部秘密标记/);
  assert.match(JSON.stringify(messages), /报告收入/);
});
