import test from "node:test";
import assert from "node:assert/strict";
import {
  alignOperatingFacts,
  operatingChart,
} from "../server/research/operating-series.mjs";
const fact = (period, value, extra = {}) => ({
  company: "Example",
  metric: "订阅收入",
  unit: "百万元",
  currency: "CNY",
  scope: "合并订阅业务",
  calendar: "12月",
  kind: "flow",
  period,
  value,
  rawValue: String(value),
  sourceId: "source-" + period,
  quote: "disclosed " + value,
  ...extra,
});
test("quarter flow derivation preserves operands and lineage; annual and cumulative are not relabeled", () => {
  const d = alignOperatingFacts([
      fact("2024-Q1", 100),
      fact("2024-H1", 240),
      fact("2024-9M", 420),
      fact("2024", 650),
    ]),
    cells = d.rows[0].cells;
  assert.equal(cells["2024-Q2"].value, 140);
  assert.equal(cells["2024-Q3"].value, 180);
  assert.equal(cells["2024-Q4"].value, 230);
  assert.equal(cells["2024-Q4"].formula, "2024 − 2024-9M");
  assert.deepEqual(cells["2024-Q4"].sourceIds, [
    "source-2024",
    "source-2024-9M",
  ]);
  assert.equal(cells["2024-H1"].status, "reported");
  assert.equal(cells["2024"].status, "reported");
  assert.equal(operatingChart(d, d.rows[0].id, "quarter").rows.length, 4);
  assert.equal(operatingChart(d, d.rows[0].id, "annual").rows.length, 1);
  assert.throws(() => operatingChart(d, d.rows[0].id, "all"), /不能混合/);
});
test("Q4 fallback subtracts the three discrete quarters, never estimates an incomplete year", () => {
  const d = alignOperatingFacts([
    fact("2024-Q1", 100),
    fact("2024-Q2", 140),
    fact("2024-Q3", 180),
    fact("2024", 650),
  ]);
  assert.equal(d.rows[0].cells["2024-Q4"].value, 230);
  const incomplete = alignOperatingFacts([
    fact("2024-Q1", 100),
    fact("2024", 650),
  ]);
  assert.equal(incomplete.rows[0].cells["2024-Q4"], undefined);
});
test("stock, average, ARPU and ratio are not differenced, even if mislabeled flow", () => {
  for (const [metric, kind, unit] of [
    ["付费用户数", "flow", "万人"],
    ["ARPU", "flow", "元/月"],
    ["平均月活", "average", "万人"],
    ["毛利率", "flow", "%"],
  ]) {
    const d = alignOperatingFacts([
      fact("2024-H1", 20, { metric, kind, unit }),
      fact("2024-Q1", 10, { metric, kind, unit }),
    ]);
    assert.equal(d.rows[0].cells["2024-Q2"], undefined, metric);
  }
});
test("different entities, currencies, scopes and units stay separate; conflicts block derivation", () => {
  const rows = alignOperatingFacts([
    fact("2024", 100),
    fact("2024", 100, { company: "Other" }),
    fact("2024", 100, { unit: "千元" }),
    fact("2024", 100, { currency: "USD" }),
    fact("2024", 100, { scope: "广告" }),
  ]);
  assert.equal(rows.rows.length, 5);
  const d = alignOperatingFacts([
    fact("2024-H1", 240),
    fact("2024-H1", 250, { sourceId: "restated" }),
    fact("2024-Q1", 100),
  ]);
  assert.equal(d.conflicts, 1);
  assert.equal(d.rows[0].cells["2024-H1"].value, null);
  assert.equal(d.rows[0].cells["2024-Q2"], undefined);
});

test("name alignment needs matching overlap, preserves originals and rejects mixed units", async () => {
  const { applyOperatingGroups } =
    await import("../server/research/operating-alignment.mjs");
  const base = [
    fact("2023", 100, {
      company: "云音乐",
      scope: "合并 在线音乐",
      calendar: "12月止年度",
    }),
    fact("2022", 90, {
      company: "云音乐",
      scope: "合并 在线音乐",
      calendar: "12月止年度",
    }),
    fact("2023", 100, {
      company: "网易云音乐",
      scope: "在线音乐服务，合并",
      calendar: "12月",
    }),
    fact("2024", 120, {
      company: "网易云音乐",
      scope: "在线音乐服务，合并",
      calendar: "12月",
    }),
  ];
  const r = applyOperatingGroups(base, [
    { factIds: [0, 1, 2, 3], reason: "2023年重叠披露一致" },
  ]);
  assert.equal(alignOperatingFacts(r.facts).rows.length, 1);
  assert.equal(r.facts[3].value, 120);
  assert.equal(r.facts[3].originalIdentity.company, "网易云音乐");
  assert.equal(base[3].company, "网易云音乐");
  const noOverlap = applyOperatingGroups(
    [base[1], base[3]],
    [{ factIds: [0, 1], reason: "同名" }],
  );
  assert.equal(alignOperatingFacts(noOverlap.facts).rows.length, 2);
  assert.ok(noOverlap.warnings.length);
  const units = applyOperatingGroups(
    [base[0], { ...base[2], unit: "千元" }],
    [{ factIds: [0, 1], reason: "同名" }],
  );
  assert.ok(units.warnings.length);
  assert.equal(units.facts[1].unit, "千元");
});

test("unknown fiscal calendar prevents quarter derivation", () => {
  const d = alignOperatingFacts([
    fact("2024-H1", 240, { calendar: "未知" }),
    fact("2024-Q1", 100, { calendar: "未知" }),
  ]);
  assert.equal(d.rows[0].cells["2024-Q2"], undefined);
});
