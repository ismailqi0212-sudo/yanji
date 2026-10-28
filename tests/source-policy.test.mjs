import test from "node:test";
import assert from "node:assert/strict";
import { resolveSourcePolicy } from "../server/agent/source-policy.mjs";
const withFiles = { documents: [{ id: "report" }] },
  empty = { documents: [] };
test("source policy defaults to current-chat attachments or public tools without attachments", () => {
  assert.equal(
    resolveSourcePolicy(withFiles, "分析收入变化").sourceMode,
    "documents",
  );
  assert.equal(
    resolveSourcePolicy(empty, "分析收入变化").sourceMode,
    "external",
  );
  assert.equal(
    resolveSourcePolicy(withFiles, "按照报告来分析收入").sourceMode,
    "documents",
  );
  assert.throws(() => resolveSourcePolicy(empty, "按照报告来分析"), /先上传/);
});
test("explicit supplemental collection combines reports with external sources", () => {
  for (const q of [
    "帮我搜集行业信息并结合财报分析",
    "联网查一下最新公告",
    "结合外部数据看看收入",
    "帮我搜索同行资料",
  ])
    assert.equal(resolveSourcePolicy(withFiles, q).sourceMode, "hybrid", q);
  assert.equal(
    resolveSourcePolicy(empty, "帮我搜集行业信息").sourceMode,
    "external",
  );
});
test("local document search and negative external requests do not enable external tools", () => {
  for (const q of [
    "搜索上传报告中的用户数",
    "搜集财报里的经营指标",
    "检索报告里披露的收入",
    "仅根据报告分析，不要联网",
    "不需要外部数据，请搜集财报里的指标",
    "不用搜索，按年报分析",
  ])
    assert.equal(resolveSourcePolicy(withFiles, q).sourceMode, "documents", q);
  assert.throws(() => resolveSourcePolicy(empty, "仅根据报告分析"), /先上传/);
});
test("explicit public-only request can ignore existing attachments", () => {
  assert.equal(
    resolveSourcePolicy(withFiles, "只用公开数据查询最新收入").sourceMode,
    "external",
  );
  assert.equal(
    resolveSourcePolicy(withFiles, "忽略上传报告，帮我搜集外部资料").sourceMode,
    "external",
  );
});
