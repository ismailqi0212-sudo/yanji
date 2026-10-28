// Percentage columns in PDF tables often put the unit in the header, not each cell.
export function pdfTablePercentages(text) {
  if (!/[%％]/.test(text) || !/百分比/.test(text)) return [];
  const values = [];
  for (const line of text.normalize("NFKC").split("\n")) {
    for (const m of line.matchAll(
      /\(?-?\d[\d,]*\)?\s+(\(?)([+-]?\d+\.\d+)\)?(?=\s|$)/g,
    )) {
      const value = Number(m[2]) * (m[1] ? -1 : 1);
      values.push(value);
      if (value < 0 && /成本|費用|费用/.test(line)) values.push(-value);
    }
  }
  // Some extractors split 66.3 across lines. Decimal values in parentheses
  // are percentage cells under this explicit amount/% table header.
  const compact = text.normalize("NFKC").replace(/\s/g, "");
  for (const m of compact.matchAll(/\((\d{1,3}\.\d+)\)/g)) {
    const value = Number(m[1]);
    values.push(-value);
    const label =
      compact
        .slice(0, m.index)
        .match(/([\p{Script=Han}]+)[^\p{Script=Han}]*$/u)?.[1] || "";
    if (/成本|費用|费用/.test(label)) values.push(value);
  }
  return values;
}
import {
  evidence,
  refs,
  searchableText,
} from "../tools/documents/documents.mjs";
export function validateAnswer(p, args, seen, calculations = []) {
  if (
    typeof args.answer !== "string" ||
    !args.answer.trim() ||
    args.answer.length > 12000
  )
    throw new Error("请交付简洁的研究回答");
  const answer = args.answer.replace(
    /\[(S[a-f0-9]{32})\](?!\()/g,
    (_, eid) => `[来源](evidence:${eid})`,
  );
  const sourceIds = [...new Set([...(args.sourceIds || []), ...refs(answer)])];
  if (
    !sourceIds.length ||
    sourceIds.some((x) => !seen.has(x) || !evidence(p, x))
  )
    throw new Error("回答必须引用已读取的真实来源");
  if (!refs(answer).length)
    throw new Error("请在正文中使用[来源](evidence:完整ID)");
  const scopedCalculations = calculations.filter(
    (c) =>
      c.sourceIds?.length &&
      c.sourceIds.every((sid) => sourceIds.includes(sid)),
  );
  const percentages = scopedCalculations
    .filter((c) =>
      ["growth", "percentage_points", "ratio"].includes(c.operation),
    )
    .flatMap((c) =>
      c.operation === "ratio" ? [c.result, c.result * 100] : [c.result],
    );
  const scan = (v, key = "") => {
    if (Array.isArray(v?.rows)) {
      for (const a of v.rows)
        for (const b of v.rows) {
          for (const k of ["grossMargin", "netMargin", "roe", "debtRatio"])
            if (typeof a[k] === "number" && typeof b[k] === "number")
              percentages.push(a[k] - b[k]);
          if (typeof a.revenue === "number" && b.revenue > 0)
            percentages.push((a.revenue / b.revenue - 1) * 100);
        }
    }
    if (
      typeof v === "number" &&
      /margin|rate|roe|amplitude|percent|debtRatio/i.test(key)
    )
      percentages.push(v);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) scan(x, k);
  };
  for (const eid of sourceIds) {
    const e = evidence(p, eid);
    if (e.type === "web")
      try {
        scan(JSON.parse(e.text));
      } catch {}
    else {
      percentages.push(...pdfTablePercentages(e.text));
      for (const m of searchableText(e.text)
        .replace(/(\d)\s*\.\s*(\d)/g, "$1.$2")
        .matchAll(/([+-]?\d+(?:\.\d+)?)\s*(?:[%％]|个?百分点)/g))
        percentages.push(Number(m[1]));
    }
  }
  // Parenthesized negatives and column-level % units are common in PDF tables.
  // Only use metrics that passed raw-number/source validation and are cited here.
  for (const analysis of Object.values(p.documentAnalysisCache || {}))
    for (const metric of analysis.metrics || []) {
      if (
        sourceIds.includes(metric.sourceId) &&
        ["grossMargin", "netMargin"].includes(metric.metric) &&
        Number.isFinite(metric.value) &&
        /[%％]|百分/.test(metric.unit)
      )
        percentages.push(metric.value);
    }
  for (const card of p.cards || [])
    if (card.kind === "worksheet")
      for (const fact of card.data.facts || [])
        if (
          sourceIds.includes(fact.sourceId) &&
          fact.kind === "ratio" &&
          /[%％]/.test(fact.unit)
        )
          percentages.push(fact.value);
  for (const c of scopedCalculations)
    if (
      c.operation === "subtract" &&
      c.values?.every((v) => percentages.some((n) => Math.abs(n - v) < 1e-8)) &&
      c.sourceIds?.every((s) => sourceIds.includes(s))
    )
      percentages.push(c.result);
  for (const m of answer.matchAll(
    /([+−-]?\d+(?:\.\d+)?)\s*(?:[%％]|个?百分点)/g,
  )) {
    const value = Number(m[1].replace("−", "-")),
      digits = m[1].split(".")[1]?.length || 0;
    const tolerance = Math.max(
      0.50001 * 10 ** -digits,
      Math.abs(value) * 1e-12,
    );
    const decline = /下降|减少|回落|下滑|收窄|降低|减幅|跌/.test(
      answer.slice(Math.max(0, m.index - 12), m.index),
    );
    if (
      !percentages.some(
        (n) =>
          Math.abs(n - value) <= tolerance ||
          (decline && value >= 0 && Math.abs(n + value) <= tolerance),
      )
    )
      throw new Error(
        `正文百分比${m[1]}未匹配工具结果或来源。请逐项按calculate原始结果重写，不要心算；已返回的工具结果可直接使用。`,
      );
  }
  return { answer, sourceIds };
}
