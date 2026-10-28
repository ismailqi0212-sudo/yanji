import test from "node:test";
import assert from "node:assert/strict";
import { worksheetOverview } from "../shared/worksheet-view.mjs";
const row = (id, metric, cells, extra = {}) => ({
  id,
  company: "company",
  metric,
  currency: "CNY",
  unit: "万元",
  scope: "合并",
  cells,
  ...extra,
});
const value = (n) => ({ value: n, status: "reported", sourceIds: ["s"] });
test("default worksheet view favors comparable business metrics and keeps conflicts and sparse disclosures accessible", () => {
  const rows = [
    row("single", "营业收入", { 2024: value(100) }),
    row("users", "付费用户", { 2023: value(20), 2024: value(30) }),
    row("income", "收入", { 2023: value(90), 2024: value(100) }),
    row("conflict", "ARPU", {
      2023: value(6),
      2024: { value: null, status: "conflict" },
    }),
  ];
  const before = JSON.stringify(rows),
    view = worksheetOverview(rows);
  assert.ok(view.primaryIds.includes("users"));
  assert.ok(!view.primaryIds.includes("single"));
  assert.ok(!view.primaryIds.includes("conflict"));
  assert.deepEqual(view.reviewIds, ["conflict"]);
  assert.equal(view.total, 4);
  assert.equal(JSON.stringify(rows), before);
});
test("alternative units are a view choice, never a value merge; overview has a bound", () => {
  const a = row("a", "付费收入", { 2023: value(1), 2024: value(2) }),
    b = row(
      "b",
      "付费收入",
      { 2023: value(1000), 2024: value(2000) },
      { unit: "千元" },
    );
  assert.equal(worksheetOverview([a, b]).primaryIds.length, 1);
  assert.equal(b.cells["2024"].value, 2000);
  const many = Array.from({ length: 14 }, (_, i) =>
    row("id" + i, "业务" + i, { 2023: value(i), 2024: value(i + 1) }),
  );
  assert.equal(worksheetOverview(many).primaryIds.length, 8);
  assert.deepEqual(
    worksheetOverview([row("only", "单期", { 2024: value(1) })]).primaryIds,
    [],
  );
});
