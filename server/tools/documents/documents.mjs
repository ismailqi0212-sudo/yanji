import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const pdfAssets = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import * as OpenCC from "opencc-js";
const simplify = OpenCC.Converter({ from: "hk", to: "cn" });
export const searchableText = (s) =>
  simplify(String(s).normalize("NFKC").toLowerCase()).replace(
    /(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g,
    "",
  );
import { dataDir, id, now } from "../../memory/store.mjs";
export function chunkText(text, size = 1100) {
  const result = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + size, text.length);
    if (end < text.length) {
      const n = text.lastIndexOf("\n", end);
      if (n > pos + size * 0.55) end = n;
    }
    result.push({ text: text.slice(pos, end), offset: pos });
    if (end === text.length) break;
    pos = Math.max(pos + 1, end - 120);
  }
  return result;
}
export async function parseDocument(buffer, name) {
  const ext = path.extname(name).toLowerCase();
  let pages = [],
    warnings = [];
  if (ext === ".pdf") {
    const pdf = await getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
      cMapUrl: path.join(pdfAssets, "cmaps") + path.sep,
      cMapPacked: true,
      standardFontDataUrl: path.join(pdfAssets, "standard_fonts") + path.sep,
    }).promise;
    if (pdf.numPages > 600) {
      await pdf.destroy();
      throw new Error("首版单份 PDF 最多支持 600 页，请拆分相关章节后导入。");
    }
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n),
        content = await page.getTextContent();
      let text = "";
      let lastY = null;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(lastY - y) > 4) text += "\n";
        text += item.str + (item.hasEOL ? "\n" : " ");
        lastY = y;
      }
      pages.push({ number: n, text: text.trim() });
    }
    await pdf.destroy();
    if (pages.some((p) => p.text.length < 20))
      warnings.push(
        "部分页面没有可提取文字，可能包含扫描件或图片。表格请对照原文核验。",
      );
  } else if (ext === ".docx") {
    const r = await mammoth.extractRawText({ buffer });
    pages = r.value
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((text, i) => ({ number: i + 1, text }));
    warnings.push("Word 按段落定位；不提供原文件页码。");
  } else if ([".txt", ".md", ".markdown"].includes(ext)) {
    const text = buffer.toString("utf8");
    if (text.includes("\u0000"))
      throw new Error("文件不是可读取的 UTF-8 文本。");
    pages = text
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((text, i) => ({ number: i + 1, text }));
  } else throw new Error("支持 PDF、DOCX、TXT 和 Markdown。");
  if (pages.reduce((n, p) => n + p.text.trim().length, 0) < 20)
    throw new Error(
      "没有提取到足够文字。请使用有文字层的文件，或粘贴相关原文。",
    );
  return { pages, warnings, type: ext.slice(1) };
}
export async function addDocument(p, buffer, name, date) {
  const hash = createHash("sha256").update(buffer).digest("hex"),
    duplicate = p.documents.find((d) => d.hash === hash);
  if (duplicate) return { duplicate: true, document: duplicate };
  const parsed = await parseDocument(buffer, name),
    did = id();
  const filename = did + path.extname(name).toLowerCase();
  fs.writeFileSync(path.join(dataDir, "files", filename), buffer, {
    mode: 0o600,
  });
  const chunks = parsed.pages.flatMap((page) =>
    chunkText(page.text).map((c, i) => ({
      id: `${did}:${page.number}:${i}`,
      page: page.number,
      ...c,
    })),
  );
  const document = {
    id: did,
    name,
    date: date || "",
    hash,
    file: filename,
    type: parsed.type,
    parserVersion: 2,
    at: now(),
    pages: parsed.pages,
    chunks,
    warnings: parsed.warnings,
    status: parsed.warnings.length ? "partial" : "ready",
  };
  p.documents.push(document);
  return { duplicate: false, document };
}
export function tokens(s) {
  s = searchableText(s);
  const words = s.match(/[a-z0-9_.%-]+|[\u4e00-\u9fff]+/g) || [];
  return [
    ...new Set(
      words.flatMap((w) =>
        /[\u4e00-\u9fff]/.test(w) && w.length > 2
          ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))
          : [w],
      ),
    ),
  ];
}
export function search(p, query, docIds = [], limit = 8) {
  const ts = tokens(query),
    rows = p.documents
      .filter((d) => !docIds.length || docIds.includes(d.id))
      .flatMap((d) =>
        d.chunks.map((c) => ({
          ...c,
          documentId: d.id,
          name: d.name,
          date: d.date,
          type: d.type,
        })),
      );
  return rows
    .map((c) => ({
      ...c,
      score: ts.reduce(
        (n, t) =>
          n +
          (searchableText(c.text).includes(t)
            ? 1 + Math.min(t.length, 5) * 0.1
            : 0),
        0,
      ),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 12));
}
export function evidence(p, eid) {
  const external = p.researchSources?.find((x) => x.id === eid);
  if (external) return external;
  for (const d of p.documents) {
    const c = d.chunks.find((x) => x.id === eid);
    if (c)
      return {
        ...c,
        documentId: d.id,
        name: d.name,
        type: d.type,
        date: d.date,
      };
  }
  return null;
}
export function publicProject(p) {
  return {
    ...p,
    documents: p.documents.map(({ pages, chunks, file, ...d }) => ({
      ...d,
      pageCount: pages.length,
      chunkCount: chunks.length,
    })),
  };
}
export function calculate({ operation, values }) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 30 ||
    values.some((v) => typeof v !== "number" || !Number.isFinite(v))
  )
    throw new Error("计算输入必须是有限数字数组，最多 30 项。");
  let result,
    warning = "";
  switch (operation) {
    case "sum":
      result = values.reduce((a, b) => a + b, 0);
      break;
    case "subtract":
      if (values.length !== 2) throw new Error("差值需要两个数字");
      result = values[0] - values[1];
      break;
    case "ratio":
      if (values.length !== 2 || values[1] === 0)
        throw new Error("比率需要两个数字，分母不能为零");
      result = values[0] / values[1];
      break;
    case "growth":
      if (values.length !== 2 || values[1] <= 0)
        throw new Error(
          "上期为零或负数，不使用常规同比增长率；请说明特殊基数。",
        );
      result = (values[0] / values[1] - 1) * 100;
      break;
    case "percentage_points":
      if (values.length !== 2) throw new Error("百分点差需要两个百分数值");
      result = values[0] - values[1];
      warning = "输入应为百分数本身，例如 30.2 和 28.1，结果单位为百分点。";
      break;
    default:
      throw new Error("不支持该计算");
  }
  if (!Number.isFinite(result)) throw new Error("计算结果超出范围");
  return { operation, values, result, warning };
}
export function refs(s) {
  return [...String(s || "").matchAll(/evidence:([a-zA-Z0-9:-]+)/g)].map(
    (x) => x[1],
  );
}
export function checkDraft(p) {
  const issues = [];
  for (const b of p.draft) {
    for (const r of refs(b.content))
      if (!evidence(p, r))
        issues.push({
          type: "invalid",
          blockId: b.id,
          message: `段落“${b.title}”存在失效引用`,
        });
    if (/\d/.test(b.content) && refs(b.content).length === 0)
      issues.push({
        type: "review",
        blockId: b.id,
        message: `段落“${b.title}”包含数字但未绑定来源，请核验。`,
      });
  }
  return issues;
}
// Conservative text checks: potential conflicts require human review, never auto-correction.
export function numericMentions(block) {
  const text = block.content.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
    metrics = [
      "营业收入",
      "营收",
      "归母净利润",
      "归属于上市公司股东的净利润",
      "毛利率",
      "经营活动产生的现金流量净额",
      "经营现金流",
    ];
  const out = [];
  for (const metric of metrics) {
    const re = new RegExp(
      metric +
        "[^\\d\\n]{0,12}([+-]?\\d[\\d,]*(?:\\.\\d+)?)\\s*(亿元|万元|元|%|％|个百分点)",
      "g",
    );
    for (const match of text.matchAll(re)) {
      const before = text.slice(Math.max(0, match.index - 22), match.index);
      const after = text.slice(
        match.index + match[0].length,
        match.index + match[0].length + 12,
      );
      const year =
        before.match(
          /(20\d{2}年?(?:第?[一二三四1234]季度|半年度|前三季度)?)[^年]{0,6}$/,
        )?.[1] || "未注明期间";
      const label = /同比|环比|增长|下降|增加|减少/.test(
        match[0].slice(metric.length),
      )
        ? "变化"
        : "数值";
      out.push({
        metric:
          metric === "营收"
            ? "营业收入"
            : metric === "归属于上市公司股东的净利润"
              ? "归母净利润"
              : metric === "经营活动产生的现金流量净额"
                ? "经营现金流"
                : metric,
        value: Number(match[1].replaceAll(",", "")),
        unit: match[2].replace("％", "%"),
        period: year,
        label,
        scope: /母公司/.test(before) ? "母公司" : "未注明口径",
        blockId: block.id,
        title: block.title,
        context: before + match[0] + after,
      });
    }
  }
  return out;
}
export function consistencyChecks(p) {
  const issues = checkDraft(p),
    groups = new Map();
  for (const b of p.draft)
    for (const m of numericMentions(b)) {
      const key = [m.metric, m.unit, m.period, m.label, m.scope].join("|");
      const existing = groups.get(key) || [];
      if (existing.some((e) => e.value !== m.value && e.blockId !== m.blockId))
        issues.push({
          type: "review",
          blockId: b.id,
          message: `可能存在数字不一致：${m.metric}（${m.period} / ${m.unit}）在“${existing[0].title}”和“${m.title}”出现不同数值。请检查期间和口径。`,
        });
      existing.push(m);
      groups.set(key, existing);
    }
  return issues;
}
