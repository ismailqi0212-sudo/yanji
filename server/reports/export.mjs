import { evidence } from "../tools/documents/documents.mjs";
const value = (n) =>
  typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { maximumFractionDigits: 4 })
    : "—";
export function exportMarkdown(c) {
  const r = c.report;
  if (!r) throw new Error("请先编成研报");
  const body = r.sections
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join("\n\n");
  const appendices = r.artifacts
    .map((a) => {
      const d = a.data;
      if (a.kind === "worksheet") {
        const esc = (s) =>
          String(s ?? "")
            .replaceAll("|", "/")
            .replaceAll("\n", " ");
        return (
          `### ${a.title}\n\n* 为累计流量差分的单季值；空缺和冲突不等于零。\n\n| 公司 / 指标 | 单位 | ${d.periods.map(esc).join(" | ")} |\n|---|---|${d.periods.map(() => "---:|").join("")}\n` +
          d.rows
            .map(
              (row) =>
                `| ${esc(row.company + " / " + row.metric)} | ${esc(row.unit)} | ${d.periods
                  .map((p) => {
                    const c = row.cells[p];
                    return !c
                      ? "—"
                      : c.status === "conflict"
                        ? "冲突待核对"
                        : value(c.value) + (c.status === "derived" ? " *" : "");
                  })
                  .join(" | ")} |`,
            )
            .join("\n")
        );
      }
      if (a.kind === "financials") {
        const metrics = [
          ["revenue", "收入"],
          ["grossProfit", "毛利"],
          ["attributableProfit", d.profitLabel || "归属股东利润"],
          ["operatingCashFlow", "经营现金流"],
          ["totalAssets", "总资产"],
          ["totalLiabilities", "总负债"],
          ["equity", "股东权益"],
          ["grossMargin", "毛利率%"],
          ["netMargin", "净利率%"],
          ["debtRatio", "资产负债率%"],
          ["eps", "每股收益"],
        ].filter(([k]) => d.rows.some((x) => Number.isFinite(x[k])));
        return (
          "### " +
          a.title +
          "\n\n单位：" +
          (d.rows[0]?.currency || "未核实") +
          "元；" +
          (d.frequency === "latest" ? "累计披露期，非单季" : "年度、合并口径") +
          "；比率为%，EPS为元/股。\n\n| 期间 | " +
          metrics.map((x) => x[1]).join(" | ") +
          " |\n|---|" +
          metrics.map(() => "---:|").join("") +
          "\n" +
          d.rows
            .map(
              (x) =>
                "| " +
                x.period +
                " | " +
                metrics.map(([k]) => value(x[k])).join(" | ") +
                " |",
            )
            .join("\n")
        );
      }
      if (a.kind === "chart")
        return (
          `### ${a.title}\n\n单位：${d.unit}；${d.scope}\n\n| 期间 | 数值 |\n|---|---:|\n` +
          d.rows.map((x) => `| ${x.period} | ${value(x.value)} |`).join("\n")
        );
      return (
        `### ${a.title}\n\n用户情景假设：收入增速${d.input.growth}%，毛利率${d.input.margin}%，测算${d.input.years}年。基准收入为${d.basePeriod}的${value(d.input.baseRevenue)}${d.currency}元。下表为假设推演，不是历史事实或公司指引。\n\n| 情景期间 | 收入 | 毛利 |\n|---|---:|---:|\n` +
        d.rows
          .map(
            (x) =>
              `| ${x.period} | ${value(x.revenue)} | ${value(x.grossProfit)} |`,
          )
          .join("\n")
      );
    })
    .join("\n\n");
  return (
    `# ${r.title}\n\n版本 ${r.version} · ${r.at}${r.stale ? " · 引用底稿已更新，请复核" : ""}\n\n${body}\n\n## 图表与数据附录\n\n${appendices}\n\n## 来源\n\n` +
    r.sourceIds
      .map((eid, i) => {
        const s = evidence(c, eid);
        return `${i + 1}. ${s?.name || "来源失效"}${s?.data?.source ? " · " + s.data.source : ""}${s?.type === "pdf" ? " · PDF物理页" + s.page : ""}${s?.date ? " · " + s.date : ""}${s?.sourceUrl ? " · " + s.sourceUrl : ""}`;
      })
      .join("\n\n")
  ).replace(
    /\[([^\]]*)\]\(evidence:([a-zA-Z0-9:-]+)\)/g,
    (_, label, eid) => label + "〔" + (r.sourceIds.indexOf(eid) + 1) + "〕",
  );
}
