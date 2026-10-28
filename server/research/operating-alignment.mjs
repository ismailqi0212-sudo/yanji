/** LLM suggests identity alignment; code preserves raw facts and requires matching overlap. */
import { safeMeasureKind } from "./operating-series.mjs";
import * as OpenCC from "opencc-js";
const simplify = OpenCC.Converter({ from: "hk", to: "cn" });
const norm = (s) =>
  simplify(String(s || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，,、]/g, "");
const currency = (s) =>
  ({
    人民币: "cny",
    rmb: "cny",
    cny: "cny",
    美元: "usd",
    usd: "usd",
    欧元: "eur",
    eur: "eur",
    港元: "hkd",
    hkd: "hkd",
  })[norm(s)] || norm(s);
const unit = (f) =>
  norm(f.unit).replace(/^(人民币|rmb|cny|美元|usd|港元|hkd|欧元|eur)/, "");
const calendar = (s) => {
  const m = norm(s).match(/(\d{1,2})月/);
  return m ? m[1] + "月" : norm(s);
};
function compatible(a, b) {
  return (
    currency(a.currency) === currency(b.currency) &&
    unit(a) === unit(b) &&
    calendar(a.calendar) === calendar(b.calendar) &&
    safeMeasureKind(a.metric, a.kind, a.unit) ===
      safeMeasureKind(b.metric, b.kind, b.unit)
  );
}
const signature = (f) => [f.company, f.metric, f.scope].map(norm).join("|");
export function applyOperatingGroups(facts, groups) {
  const output = facts.map((f) => ({ ...f })),
    assigned = new Set(),
    warnings = [];
  for (const group of groups || []) {
    const ids = group.factIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((i) => !Number.isInteger(i) || !facts[i] || assigned.has(i))
    ) {
      warnings.push("名称归并候选包含无效或重复编号，已忽略");
      continue;
    }
    const buckets = [];
    for (const i of ids) {
      const bucket = buckets.find((b) => compatible(facts[b[0]], facts[i]));
      if (bucket) bucket.push(i);
      else buckets.push([i]);
    }
    if (buckets.length > 1)
      warnings.push("归并建议含不同单位或期间口径，已分别核对，未换算混合");
    for (const bucket of buckets) {
      const first = facts[bucket[0]],
        parts = bucket.map((i) => facts[i]);
      // Different wordings need a connected matching-period/value anchor, not just model confidence.
      const signatures = [...new Set(parts.map(signature))],
        connected = new Set([signatures[0]]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const a of parts)
          for (const b of parts)
            if (
              connected.has(signature(a)) &&
              !connected.has(signature(b)) &&
              a.period === b.period &&
              a.value === b.value
            ) {
              connected.add(signature(b));
              changed = true;
            }
      }
      if (connected.size !== signatures.length) {
        warnings.push(
          `${first.metric}：归并名称缺少同期间同数值交叉依据，保留分行`,
        );
        continue;
      }
      for (const i of bucket) {
        assigned.add(i);
        output[i] = {
          ...facts[i],
          company: first.company,
          metric: first.metric,
          scope: first.scope,
          unit: first.unit,
          currency: first.currency,
          calendar: first.calendar,
          alignmentReason: String(group.reason || "同期间披露值一致"),
          originalIdentity: {
            company: facts[i].company,
            metric: facts[i].metric,
            scope: facts[i].scope,
            unit: facts[i].unit,
            currency: facts[i].currency,
            calendar: facts[i].calendar,
          },
        };
      }
    }
  }
  return { facts: output, warnings };
}
