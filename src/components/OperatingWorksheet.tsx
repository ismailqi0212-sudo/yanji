import { worksheetOverview } from "../../shared/worksheet-view.mjs";
import { useState } from "react";
import { ChartLine, DownloadSimple } from "@phosphor-icons/react";
import Chart from "./Chart";

type Cell = {
  value: number | null;
  status: string;
  sourceIds: string[];
  formula?: string;
  operands?: { period: string; value: number; sourceIds: string[] }[];
  candidates?: { value: number; sourceId: string; rawValue: string }[];
};
type Row = {
  id: string;
  metric: string;
  company: string;
  unit: string;
  currency: string;
  scope: string;
  kind: string;
  cells: Record<string, Cell>;
};
const format = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const safe = (v: unknown) => {
  let s = String(v ?? "");
  if (typeof v !== "number" && /^[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
function download(rows: unknown[][], name: string) {
  const blob = new Blob(
    ["\uFEFF" + rows.map((r) => r.map(safe).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function OperatingWorksheet({
  data,
  onSource,
  onChart,
  onCompose,
}: {
  data: any;
  onSource: (id: string) => void;
  onChart?: (metric: string) => void;
  onCompose?: () => void;
}) {
  const rows = data.rows as Row[];
  const overview = worksheetOverview(rows);
  const [rowView, setRowView] = useState(
    overview.primaryIds.length ? "primary" : "all",
  );
  const visibleRows =
    rowView === "all"
      ? rows
      : (rowView === "primary"
          ? overview.primaryIds
          : overview.reviewIds
        ).flatMap((id) => {
          const row = rows.find((r) => r.id === id);
          return row ? [row] : [];
        });
  const [mode, setMode] = useState("all"),
    [active, setActive] = useState(overview.primaryIds[0] || rows[0]?.id || ""),
    [kind, setKind] = useState("line"),
    [detail, setDetail] = useState<{
      row: Row;
      period: string;
      cell: Cell;
    } | null>(null);
  const periods = (data.periods as string[]).filter(
    (p) =>
      mode === "all" ||
      (mode === "annual" ? /^\d{4}$/.test(p) : /-Q[1-4]$/.test(p)),
  );
  const row = rows.find((r) => r.id === active);
  const chartMode =
    mode === "all"
      ? (data.periods as string[]).some((p) => /^\d{4}$/.test(p))
        ? "annual"
        : "quarter"
      : mode;
  const chartPeriods = (data.periods as string[]).filter((p) =>
    chartMode === "annual" ? /^\d{4}$/.test(p) : /-Q[1-4]$/.test(p),
  );
  const exportTable = () =>
    download(
      [
        ["公司", "指标", "单位", "币种", "口径", "指标类型", ...periods],
        ...visibleRows.map((r) => [
          r.company,
          r.metric,
          r.unit,
          r.currency,
          r.scope,
          r.kind,
          ...periods.map((p) => {
            const c = r.cells[p];
            return c?.status === "conflict" ? "冲突待核对" : (c?.value ?? "");
          }),
        ]),
      ],
      "经营数据底稿",
    );
  const exportLineage = () =>
    download(
      [
        [
          "公司",
          "指标",
          "期间",
          "原值或计算结果",
          "单位",
          "状态",
          "公式",
          "来源ID",
          "来源文件与物理页",
        ],
        ...visibleRows.flatMap((r) =>
          periods.flatMap((p) => {
            const c = r.cells[p];
            return c
              ? [
                  [
                    r.company,
                    r.metric,
                    p,
                    c.value ?? "",
                    r.unit,
                    c.status,
                    c.formula || "",
                    c.sourceIds.join(";"),
                    c.sourceIds
                      .map((id) => {
                        const f = data.facts?.find(
                          (f: any) => f.sourceId === id,
                        );
                        return (
                          (f?.documentName ||
                            data.documents?.find((d: any) =>
                              id.startsWith(d.id + ":"),
                            )?.name ||
                            id.split(":")[0]) +
                          " · 第" +
                          (f?.page || id.split(":")[1]) +
                          "页"
                        );
                      })
                      .join(";"),
                  ],
                ]
              : [];
          }),
        ),
      ],
      "经营数据-来源与公式",
    );
  return (
    <div className="operating-worksheet">
      <div className="worksheet-overview" aria-label="底稿视图">
        <div>
          {[
            ["primary", "跨期指标", overview.primaryIds.length],
            ["all", "全部披露", rows.length],
            ["review", "待核对", overview.reviewIds.length],
          ].map(([id, label, n]) => (
            <button
              key={id}
              className={rowView === id ? "active" : ""}
              disabled={!n}
              onClick={() => {
                setRowView(String(id));
                const ids =
                  id === "primary"
                    ? overview.primaryIds
                    : id === "review"
                      ? overview.reviewIds
                      : rows.map((r) => r.id);
                if (!ids.includes(active)) setActive(ids[0] || "");
                setDetail(null);
              }}
            >
              {label} <small>{n}</small>
            </button>
          ))}
        </div>
        {onCompose && (
          <button className="worksheet-compose" onClick={onCompose}>
            用底稿写点评
          </button>
        )}
      </div>
      <div className="worksheet-toolbar">
        <div className="worksheet-modes">
          {[
            ["all", "全部期间"],
            ["annual", "年度"],
            ["quarter", "单季"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={mode === id ? "active" : ""}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div>
          <button onClick={exportTable}>
            <DownloadSimple size={13} />
            下载当前表格
          </button>
          <button onClick={exportLineage}>来源与公式</button>
        </div>
      </div>
      <p className="worksheet-note">
        {rowView === "primary"
          ? "优先展示多期可比指标，其他口径保留在“全部披露”。"
          : "点指标看图，点数值核对原文。"}{" "}
        带 * 为单季推导，— 为未取得。
      </p>
      <div className="worksheet-scroll">
        <table className="worksheet-table">
          <thead>
            <tr>
              <th>指标 / 单位</th>
              {periods.map((p) => (
                <th key={p}>{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <tr key={r.id}>
                <th>
                  <button
                    className={active === r.id ? "active" : ""}
                    onClick={() => {
                      setActive(r.id);
                      setDetail(null);
                    }}
                  >
                    <ChartLine size={13} />
                    {r.metric}
                  </button>
                  <small>
                    {r.company} · {r.unit}
                  </small>
                  <small>
                    {r.scope} ·{" "}
                    {{
                      flow: "期间流量",
                      stock: "披露规模（不差分）",
                      average: "平均值",
                      ratio: "比率",
                    }[r.kind] || r.kind}
                  </small>
                </th>
                {periods.map((p) => {
                  const c = r.cells[p];
                  return (
                    <td key={p}>
                      {!c ? (
                        "—"
                      ) : (
                        <button
                          className={"worksheet-value " + c.status}
                          title={
                            c.status === "derived"
                              ? c.formula
                              : c.status === "conflict"
                                ? "多份报告披露值冲突，点击核对"
                                : "查看原文"
                          }
                          onClick={() => {
                            setDetail({ row: r, period: p, cell: c });
                            if (c.status === "reported")
                              onSource(c.sourceIds[0]);
                          }}
                        >
                          {c.status === "conflict" ? "冲突" : format(c.value)}
                          {c.status === "derived" ? " *" : ""}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {periods.length === 0 && (
        <p className="muted small">
          没有取得这一类期间的数据；补充对应报告后再整理。
        </p>
      )}
      {detail && detail.cell.status !== "reported" && (
        <div className="worksheet-cell-detail">
          <strong>
            {detail.row.metric} · {detail.period}
          </strong>
          {detail.cell.status === "derived" ? (
            <>
              <p>
                {detail.cell.formula} = {format(detail.cell.value)}{" "}
                {detail.row.unit}
              </p>
              {detail.cell.operands?.map((o) => (
                <button key={o.period} onClick={() => onSource(o.sourceIds[0])}>
                  {o.period}：{format(o.value)} · 核对原值
                </button>
              ))}
            </>
          ) : (
            <>
              <p>同期间披露值不一致，未选取其中一个值，也未用它推导季度。</p>
              {detail.cell.candidates?.map((c, i) => (
                <button key={i} onClick={() => onSource(c.sourceId)}>
                  {c.rawValue} · 查看原文
                </button>
              ))}
            </>
          )}
        </div>
      )}
      {row && periods.length > 0 && (
        <div className="worksheet-chart">
          <header>
            <span>
              {row.metric} · {chartMode === "annual" ? "年度" : "单季"}趋势
            </span>
            <div>
              <button
                className={kind === "line" ? "active" : ""}
                onClick={() => setKind("line")}
              >
                折线
              </button>
              <button
                className={kind === "bar" ? "active" : ""}
                onClick={() => setKind("bar")}
              >
                柱状
              </button>
              {onChart && (
                <button onClick={() => onChart(row.id + ":" + chartMode)}>
                  保存为研报图表
                </button>
              )}
            </div>
          </header>
          <Chart
            data={{
              title: row.company + " · " + row.metric,
              unit: row.unit,
              scope: row.scope,
              kind,
              sourceName: "上传报告；派生季度值见底稿公式",
              rows: chartPeriods.map((period) => ({
                period,
                value:
                  row.cells[period]?.status === "conflict"
                    ? null
                    : (row.cells[period]?.value ?? null),
                sourceId: row.cells[period]?.sourceIds[0],
              })),
            }}
            onSource={onSource}
          />
        </div>
      )}
      <details className="worksheet-limits">
        <summary>覆盖范围与核对事项</summary>
        <p>{data.notes}</p>
        <p>
          本轮：{rows.length}组口径 · {data.periods.length}个期间 ·{" "}
          {data.conflicts}处冲突。年度、半年累计、九个月累计与单季分别标识。
        </p>
        {data.warnings?.map((w: string, i: number) => (
          <p key={i}>{w}</p>
        ))}
      </details>
    </div>
  );
}
