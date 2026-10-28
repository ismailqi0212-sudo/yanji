// Contains financial table layout adapted from virattt/ai-financial-agent.
// Copyright 2024 Vercel, Inc. Apache-2.0; see LICENSE and NOTICE.
// Changes: HeroUI rendering, research artifacts, local evidence and report selection.
import OperatingWorksheet from "./OperatingWorksheet";
import { useState } from "react";
import { Button, Input, Textarea, Checkbox } from "@heroui/react";
import {
  ChartLine,
  Table,
  FileText,
  SlidersHorizontal,
  ArrowSquareOut,
  Check,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import type { Card } from "../types";
import {
  formatFinancialValue,
  formatRatio,
} from "../upstream/financial-table-utils";
import Markdown from "./Markdown";
import Chart from "./Chart";
type Props = {
  card: Card;
  onChange: (changes: any) => Promise<void>;
  onSource: (id: string) => void;
  onChart: (metric: string) => void;
  readOnly?: boolean;
  inlineSources?: boolean;
  onCompose?: () => void;
  onDocument?: (id: string, page?: number) => void;
  onAccept?: (id: string) => Promise<void>;
  onAsk?: (question: string) => void;
};
const labels: Record<string, string> = {
  worksheet: "经营底稿",
  documentAnalysis: "报告分析",
  revision: "章节修订",
  filings: "公司披露",
  brief: "研究发现",
  financials: "财务底稿",
  market: "行情",
  chart: "图表",
  scenario: "假设沙盘",
  gaps: "待核实",
};
const icons: Record<string, any> = {
  worksheet: Table,
  documentAnalysis: FileText,
  revision: FileText,
  filings: FileText,
  brief: FileText,
  financials: Table,
  market: ChartLine,
  chart: ChartLine,
  scenario: SlidersHorizontal,
  gaps: FileText,
};
export default function ResearchCard({
  card: c,
  onChange,
  onSource,
  onChart,
  readOnly = false,
  inlineSources = false,
  onCompose,
  onAsk,
  onAccept,
  onDocument,
}: Props) {
  const [editing, setEditing] = useState(false),
    [title, setTitle] = useState(c.title),
    [body, setBody] = useState(c.data.body || ""),
    [notes, setNotes] = useState(c.data.notes || ""),
    [metric, setMetric] = useState("revenue"),
    [form, setForm] = useState(c.data.input),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const Icon = icons[c.kind];
  async function change(value: any) {
    setBusy(true);
    setError("");
    try {
      await onChange(value);
      setEditing(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className={
        "research-card card-" + c.kind + (c.selected ? " selected" : "")
      }
    >
      <header>
        <div>
          <Icon size={15} />
          <span>{labels[c.kind]}</span>
          {c.kind !== "documentAnalysis" && c.sourceIds.length > 0 && (
            <em>
              {c.data.fromMaterials ||
              c.sourceIds.every((s) => !s.startsWith("S"))
                ? "上传材料"
                : "外部数据"}
            </em>
          )}
          {c.kind === "brief" && (
            <em>
              {{ fact: "事实", inference: "推断", risk: "反向证据" }[
                c.data.kind as string
              ] || "研究判断"}
            </em>
          )}
        </div>
        {!readOnly && !["gaps", "revision"].includes(c.kind) && (
          <Checkbox
            size="sm"
            isSelected={c.selected}
            onValueChange={(selected) => change({ selected })}
            aria-label={"选入研报：" + c.title}
          >
            选入研报
          </Checkbox>
        )}
      </header>
      <div className="card-content">
        {editing && ["brief", "chart"].includes(c.kind) ? (
          <div className="card-edit">
            <Input label="标题" value={title} onValueChange={setTitle} />
            {c.kind === "brief" && (
              <>
                <Textarea
                  label="判断与依据"
                  value={body}
                  onValueChange={setBody}
                  minRows={5}
                />
                <Textarea
                  label="批注（可选）"
                  value={notes}
                  onValueChange={setNotes}
                />
              </>
            )}
            <div className="inline-actions">
              <Button
                size="sm"
                className="primary"
                isLoading={busy}
                onPress={() => change({ title, body, notes })}
              >
                保存修改
              </Button>
              <Button
                size="sm"
                variant="light"
                onPress={() => setEditing(false)}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="card-title">
              <h3>{c.title}</h3>
              {["brief", "chart"].includes(c.kind) && !readOnly && (
                <button
                  title="编辑研究卡片"
                  aria-label="编辑研究卡片"
                  onClick={() => {
                    setTitle(c.title);
                    setBody(c.data.body);
                    setNotes(c.data.notes || "");
                    setEditing(true);
                  }}
                >
                  <PencilSimple size={15} />
                </button>
              )}
            </div>
            {c.kind === "worksheet" && (
              <OperatingWorksheet
                data={c.data}
                onSource={onSource}
                onChart={readOnly ? undefined : onChart}
                onCompose={readOnly ? undefined : onCompose}
              />
            )}
            {c.kind === "documentAnalysis" && (
              <>
                <div className="document-coverage">
                  <span>
                    已分析 {c.data.processedPages} / {c.data.pages}{" "}
                    个物理页的可提取文字 · {c.data.parts} 批长上下文
                  </span>
                  <button onClick={() => onDocument?.(c.data.documentId, 1)}>
                    打开PDF原文 ↗
                  </button>
                </div>
                <p className="muted small">
                  完整阅读提取文字后建立的底稿；无文字页不在阅读范围内。
                </p>
                {c.data.findings.map((f: any, i: number) => (
                  <section className="document-finding" key={i}>
                    <b>{f.topic}</b>
                    <p>{f.text}</p>
                    <button onClick={() => onSource(f.sourceId)}>
                      原文第 {f.page} 页 ↗
                    </button>
                    <details>
                      <summary>核对原文引文</summary>
                      <blockquote>{f.quote}</blockquote>
                    </details>
                  </section>
                ))}
                {c.data.metrics.length > 0 && (
                  <details className="material-chart-data">
                    <summary>直接披露指标 · {c.data.metrics.length} 项</summary>
                    <table className="compact-table">
                      <thead>
                        <tr>
                          <th>年度</th>
                          <th>指标</th>
                          <th>原文数值</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.data.metrics.map((m: any, i: number) => (
                          <tr key={i}>
                            <td>{m.period}</td>
                            <td>
                              {
                                {
                                  revenue: "收入",
                                  grossMargin: "毛利率",
                                  grossProfit: "毛利",
                                  attributableProfit: "归母净利润",
                                  operatingCashFlow: "经营现金流",
                                  netMargin: "净利率",
                                }[m.metric as string]
                              }
                            </td>
                            <td>
                              <button onClick={() => onSource(m.sourceId)}>
                                {m.rawValue} {m.unit} ↗
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
                {c.data.warnings.map((w: string, i: number) => (
                  <p className="muted small" key={i}>
                    {w}
                  </p>
                ))}
              </>
            )}
            {c.kind === "brief" && (
              <>
                <Markdown
                  text={c.data.body.replace(
                    /(观察|投资含义|反向解释|验证条件)：/g,
                    "\n\n**$1**\n\n",
                  )}
                  onSource={onSource}
                />
                {!readOnly && onAsk && c.data.nextQuestions?.length > 0 && (
                  <div className="followup-questions">
                    {c.data.nextQuestions.map((q: string) => (
                      <button key={q} onClick={() => onAsk(q)}>
                        {q}
                        <ArrowSquareOut size={12} />
                      </button>
                    ))}
                  </div>
                )}
                {c.data.notes && (
                  <p className="card-note">批注：{c.data.notes}</p>
                )}
              </>
            )}
            {c.kind === "revision" && (
              <>
                <p className="revision-reason">{c.data.reason}</p>
                <details className="revision-before">
                  <summary>查看原稿 · v{c.data.baseVersion}</summary>
                  <Markdown text={c.data.before} onSource={onSource} />
                </details>
                <div className="revision-proposed">
                  <span>建议修改为</span>
                  <Markdown text={c.data.body} onSource={onSource} />
                </div>
                {c.data.remainingGaps?.length > 0 && (
                  <ul className="gap-list">
                    {c.data.remainingGaps.map((g: string, i: number) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                )}
                {c.data.status === "pending" && onAccept ? (
                  <Button
                    className="primary"
                    size="sm"
                    isLoading={busy}
                    onPress={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await onAccept(c.id);
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    确认写入研报
                  </Button>
                ) : (
                  <p className="muted small">
                    已写入研报 v{c.data.acceptedVersion}
                  </p>
                )}
              </>
            )}
            {c.kind === "gaps" && (
              <ul className="gap-list">
                {c.data.items.map((v: string, i: number) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            )}
            {c.kind === "financials" && (
              <>
                <FinancialTable
                  data={c.data}
                  sourceId={c.sourceIds[0]}
                  onSource={onSource}
                />
                {!readOnly && (
                  <div className="inline-actions">
                    <select
                      aria-label="选择图表指标"
                      value={metric}
                      onChange={(e) => setMetric(e.target.value)}
                    >
                      <option value="revenue">营业收入</option>
                      <option value="grossMargin">毛利率</option>
                      <option value="attributableProfit">归属股东利润</option>
                      <option value="operatingCashFlow">经营现金流</option>
                      <option value="totalAssets">总资产</option>
                      <option value="debtRatio">资产负债率</option>
                      <option value="eps">每股收益</option>
                    </select>
                    <button
                      className="quiet-button"
                      onClick={() => onChart(metric)}
                    >
                      <ChartLine size={14} />
                      生成图表
                    </button>
                  </div>
                )}
              </>
            )}
            {c.kind === "filings" && (
              <>
                <div className="filings-list">
                  {c.data.rows.map((r: any) => (
                    <a
                      key={r.url}
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <time>{r.date}</time>
                      <span>{r.title}</span>
                      <ArrowSquareOut size={13} />
                    </a>
                  ))}
                </div>
                <p className="muted small">{c.data.note}</p>
              </>
            )}
            {c.kind === "market" && (
              <Market
                data={c.data}
                sourceId={c.sourceIds[0]}
                onSource={onSource}
              />
            )}{" "}
            {c.kind === "chart" && (
              <>
                <div className="chart-type">
                  <button
                    className={c.data.kind !== "bar" ? "active" : ""}
                    disabled={readOnly}
                    onClick={() => change({ kind: "line" })}
                  >
                    折线图
                  </button>
                  <button
                    className={c.data.kind === "bar" ? "active" : ""}
                    disabled={readOnly}
                    onClick={() => change({ kind: "bar" })}
                  >
                    柱状图
                  </button>
                </div>
                <Chart data={c.data} onSource={onSource} />
                {c.data.fromMaterials && (
                  <details className="material-chart-data">
                    <summary>核对原始数据</summary>
                    <table className="compact-table">
                      <thead>
                        <tr>
                          <th>期间</th>
                          <th>数值（{c.data.unit}）</th>
                          <th>依据</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.data.rows.map((r: any) => (
                          <tr key={r.period}>
                            <td>{r.period}</td>
                            <td>{r.value ?? "缺失"}</td>
                            <td>
                              <button onClick={() => onSource(r.sourceId)}>
                                查看原文
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </>
            )}
            {c.kind === "scenario" && (
              <>
                <p className="muted small">
                  基准：{c.data.basePeriod} · 收入{" "}
                  {formatFinancialValue(c.data.input.baseRevenue)}{" "}
                  {c.data.currency}元
                </p>
                {!readOnly && (
                  <div className="scenario-form">
                    <Input
                      label="收入增速假设（%）"
                      type="number"
                      step="0.1"
                      value={String(form.growth)}
                      onValueChange={(v) => setForm({ ...form, growth: v })}
                    />
                    <Input
                      label="毛利率假设（%）"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={String(form.margin)}
                      onValueChange={(v) => setForm({ ...form, margin: v })}
                    />
                    <Input
                      label="测算年数"
                      type="number"
                      min="1"
                      max="3"
                      step="1"
                      value={String(form.years)}
                      onValueChange={(v) => setForm({ ...form, years: v })}
                    />
                    <Button
                      size="sm"
                      variant="bordered"
                      isLoading={busy}
                      onPress={() =>
                        change({
                          input: {
                            ...form,
                            growth: Number(form.growth),
                            margin: Number(form.margin),
                            years: Number(form.years),
                          },
                        })
                      }
                    >
                      重算
                    </Button>
                  </div>
                )}
                <p className="scenario-label">
                  情景测算 · 用户假设，非公司指引
                </p>
                <table className="compact-table">
                  <thead>
                    <tr>
                      <th>情景期间</th>
                      <th>收入</th>
                      <th>毛利</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.data.rows.map((r: any) => (
                      <tr key={r.period}>
                        <td>{r.period}</td>
                        <td>{formatFinancialValue(r.revenue)}</td>
                        <td>{formatFinancialValue(r.grossProfit)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Chart
                  data={{
                    title: c.title + " · 情景收入",
                    unit: c.data.currency + "元",
                    scope: "用户假设",
                    sourceName: "历史收入基准＋用户假设；非公司预测",
                    rows: c.data.rows.map((r: any) => ({
                      period: r.period,
                      value: r.revenue,
                      sourceId: c.sourceIds.at(-1),
                    })),
                  }}
                  onSource={onSource}
                />
              </>
            )}
          </>
        )}
        {error && <p className="inline-error">{error}</p>}
      </div>
      {!inlineSources &&
        c.sourceIds.length > 0 &&
        c.kind !== "documentAnalysis" && (
          <footer>
            <div>
              {c.sourceIds.map((eid, j) => (
                <button key={eid} onClick={() => onSource(eid)}>
                  来源 {j + 1}
                  <ArrowSquareOut size={10} />
                </button>
              ))}
            </div>
            {c.version > 1 && <span>已修订 · v{c.version}</span>}
          </footer>
        )}
    </article>
  );
}
// Adapted from upstream FinancialTableBase: metric rows, report-period columns,
// missing-value suppression and separate formatting. HeroUI replaces Radix primitives.
export function FinancialTable({
  data,
  sourceId,
  onSource,
}: {
  data: any;
  sourceId: string;
  onSource: (id: string) => void;
}) {
  const [tab, setTab] = useState("经营");
  const groups: Record<string, string[][]> = {
    经营: [
      ["revenue", "营业收入", "amount"],
      ["grossProfit", "毛利", "amount"],
      ["attributableProfit", data.profitLabel || "归属股东利润", "amount"],
      ["deductedProfit", "扣非归母利润", "amount"],
      ["grossMargin", "毛利率", "percent"],
      ["netMargin", "净利率", "percent"],
      ["eps", "每股收益", "ratio"],
      ["roe", "ROE", "percent"],
    ],
    现金与负债: [
      ["operatingCashFlow", "经营现金流", "amount"],
      ["cash", "期末现金", "amount"],
      ["totalAssets", "总资产", "amount"],
      ["totalLiabilities", "总负债", "amount"],
      ["equity", "股东权益", "amount"],
      ["debtRatio", "资产负债率", "percent"],
    ],
  };
  const rows = groups[tab];
  return (
    <>
      <div className="financial-tabs">
        {Object.keys(groups).map((g) => (
          <button
            key={g}
            className={tab === g ? "active" : ""}
            onClick={() => setTab(g)}
          >
            {g}
          </button>
        ))}
      </div>
      <div className="table-caption">
        {data.rows[0]?.currency}元 ·{" "}
        {data.frequency === "latest" ? "累计披露期，非单季" : "年度 / 合并口径"}{" "}
        <span>M 百万 · B 十亿</span>
      </div>
      <div className="table-overflow">
        <table className="financial-table">
          <thead>
            <tr>
              <th>指标</th>
              {data.rows.map((r: any) => (
                <th key={r.period}>
                  {data.frequency === "latest"
                    ? r.period
                    : r.period.slice(0, 4)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows
              .filter(([key]) =>
                data.rows.some((r: any) => Number.isFinite(r[key])),
              )
              .map(([key, label, type]) => (
                <tr key={key}>
                  <th>{label}</th>
                  {data.rows.map((r: any) => (
                    <td key={r.period}>
                      <button onClick={() => onSource(sourceId)}>
                        {!Number.isFinite(r[key])
                          ? "—"
                          : type === "percent"
                            ? r[key].toFixed(2) + "%"
                            : type === "ratio"
                              ? r[key].toFixed(2)
                              : formatFinancialValue(r[key])}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <details className="data-method">
        <summary>数据口径与来源</summary>
        <p>
          {data.source} · {data.note}
        </p>
        <p>
          提取时间：{data.fetchedAt?.slice(0, 16).replace("T", " ")}
          ；缺失值不补齐。点击数值查看原始快照。
        </p>
      </details>
    </>
  );
}
function Market({
  data,
  sourceId,
  onSource,
}: {
  data: any;
  sourceId: string;
  onSource: (id: string) => void;
}) {
  const [range, setRange] = useState(60);
  const q = data.quote || {},
    metrics = q.metrics || {},
    allBars = data.bars || [],
    bars = allBars.slice(-range),
    last = allBars.at(-1);
  return (
    <>
      <div className="market-snapshot">
        <strong>
          {last?.close ?? "—"}
          <small>{data.currency || q.currency || ""}</small>
        </strong>
        <span>{data.latestDate || q.asOf?.slice(0, 10) || "日期未提供"}</span>
      </div>
      <div className="market-metrics">
        {[
          ["PE (TTM)", metrics.peTtm],
          ["PB", metrics.pb],
          ["总市值", metrics.marketCap],
        ].map(([name, n]) => (
          <button key={String(name)} onClick={() => onSource(sourceId)}>
            <span>{name}</span>
            <b>
              {typeof n === "number"
                ? name === "总市值"
                  ? formatFinancialValue(n)
                  : formatRatio(n)
                : "—"}
            </b>
          </button>
        ))}
      </div>
      {bars.length > 0 && (
        <div className="market-ranges">
          {[
            [20, "1个月"],
            [60, "3个月"],
            [120, "6个月"],
          ].map(([n, label]) => (
            <button
              key={n}
              className={range === n ? "active" : ""}
              onClick={() => setRange(Number(n))}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {bars.length > 0 && (
        <Chart
          data={{
            title: (data.name || data.symbol) + " · 收盘价",
            unit: data.currency,
            scope: data.adjustment || "日线",
            sourceName: data.source,
            rows: bars.map((r: any) => ({
              period: r.time,
              value: r.close,
              sourceId,
            })),
          }}
          onSource={onSource}
        />
      )}
      <p className="muted small">
        行情日期与财报期间分别标注；价格不代表实时成交报价。
      </p>
    </>
  );
}
