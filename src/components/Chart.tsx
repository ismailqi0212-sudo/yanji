import { useRef } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { formatFinancialValue } from "../upstream/financial-table-utils";
export type Series = {
  title: string;
  unit: string;
  scope?: string;
  kind?: string;
  sourceName?: string;
  rows: { period: string; value: number | null; sourceId?: string }[];
};
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Chart({
  data,
  onSource,
  compact = false,
}: {
  data: Series;
  onSource: (id: string) => void;
  compact?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null),
    values = data.rows.flatMap((r) =>
      r.value === null || !Number.isFinite(r.value) ? [] : [r.value],
    );
  if (!values.length) return <p className="muted">暂无可绘制的数据</p>;
  const low =
      data.kind === "bar" ? Math.min(0, ...values) : Math.min(...values),
    high = Math.max(...values),
    pad = (high - low) * 0.13 || Math.max(1, Math.abs(high) * 0.05),
    min = low - (data.kind === "bar" ? 0 : pad),
    max = high + pad;
  const label = (n: number) =>
    data.unit === "%" ? n.toFixed(2) : formatFinancialValue(n);
  const x = (i: number) => 75 + (i * 650) / Math.max(1, data.rows.length - 1),
    y = (n: number) => 260 - ((n - min) / (max - min)) * 165;
  async function download(type: string) {
    const s = new XMLSerializer().serializeToString(ref.current!);
    if (type === "svg") {
      save(new Blob([s], { type: "image/svg+xml" }), data.title + ".svg");
      return;
    }
    if (type === "csv") {
      const q = (v: unknown) =>
        '"' + String(v ?? "").replaceAll('"', '""') + '"';
      save(
        new Blob(
          [
            "\ufeff" +
              [
                ["期间", "数值", "单位", "来源"],
                ...data.rows.map((r) => [
                  r.period,
                  r.value,
                  data.unit,
                  data.sourceName || "",
                ]),
              ]
                .map((r) => r.map(q).join(","))
                .join("\r\n"),
          ],
          { type: "text/csv;charset=utf-8" },
        ),
        data.title + ".csv",
      );
      return;
    }
    const url = URL.createObjectURL(new Blob([s], { type: "image/svg+xml" })),
      img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 700;
      canvas.getContext("2d")!.drawImage(img, 0, 0, 1600, 700);
      canvas.toBlob((b) => {
        if (b) save(b, data.title + ".png");
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
  return (
    <div className={"series-chart " + (compact ? "compact" : "")}>
      <svg
        ref={ref}
        viewBox="0 0 800 350"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={data.title}
      >
        <defs>
          <linearGradient
            id={("shade-" + data.title).replace(/[^a-zA-Z0-9-]/g, "")}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor="#666" stopOpacity=".18" />
            <stop offset="100%" stopColor="#666" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect className="chart-bg" width="800" height="350" fill="white" />
        <text
          x="32"
          y="30"
          fill="#202124"
          fontSize="17"
          fontFamily="Arial,sans-serif"
        >
          {data.title}
        </text>
        <text x="32" y="53" fill="#777" fontSize="11">
          {data.unit} · {data.scope || ""}
        </text>
        {[0, 1, 2, 3].map((i) => {
          const v = min + ((max - min) * i) / 3;
          return (
            <g key={i}>
              <line x1="72" x2="738" y1={y(v)} y2={y(v)} stroke="#e7e7e7" />
              <text
                x="64"
                y={y(v) + 4}
                fill="#777"
                fontSize="10"
                textAnchor="end"
              >
                {label(v)}
              </text>
            </g>
          );
        })}
        {data.kind !== "bar" && data.rows.every((r) => r.value !== null) && (
          <path
            d={
              "M" +
              x(0) +
              ",260 " +
              data.rows
                .map((r, i) => "L" + x(i) + "," + y(r.value!))
                .join(" ") +
              " L" +
              x(data.rows.length - 1) +
              ",260 Z"
            }
            fill={
              "url(#" +
              ("shade-" + data.title).replace(/[^a-zA-Z0-9-]/g, "") +
              ")"
            }
          />
        )}
        {data.kind !== "bar" &&
          data.rows.map((r, i) =>
            i && r.value !== null && data.rows[i - 1].value !== null ? (
              <line
                key={i}
                x1={x(i - 1)}
                x2={x(i)}
                y1={y(data.rows[i - 1].value!)}
                y2={y(r.value)}
                stroke="#292a2d"
                strokeWidth="2"
              />
            ) : null,
          )}
        {data.rows.map((r, i) => (
          <g key={i}>
            {r.value !== null && (
              <g
                onClick={() => r.sourceId && onSource(r.sourceId)}
                style={{ cursor: r.sourceId ? "pointer" : "default" }}
              >
                <title>
                  {r.period}：{r.value} {data.unit}
                </title>
                {data.kind === "bar" ? (
                  <rect
                    x={x(i) - Math.min(22, 250 / data.rows.length)}
                    y={Math.min(y(0), y(r.value))}
                    width={Math.min(44, 500 / data.rows.length)}
                    height={Math.max(1, Math.abs(y(r.value) - y(0)))}
                    fill="#3b3c40"
                  />
                ) : (
                  <circle
                    cx={x(i)}
                    cy={y(r.value)}
                    r={data.rows.length > 20 ? 1.7 : 4}
                    fill="#292a2d"
                  />
                )}
                {data.rows.length <= 8 && (
                  <text
                    x={x(i)}
                    y={y(r.value) - 10}
                    fontSize="11"
                    fill="#333"
                    textAnchor="middle"
                  >
                    {label(r.value)}
                  </text>
                )}
              </g>
            )}
            {(data.rows.length < 8 ||
              i % Math.ceil(data.rows.length / 5) === 0 ||
              i === data.rows.length - 1) && (
              <text
                x={x(i)}
                y="284"
                fill="#777"
                fontSize="10"
                textAnchor="middle"
              >
                {r.period}
              </text>
            )}
          </g>
        ))}
        <text x="32" y="325" fill="#777" fontSize="10">
          来源：{data.sourceName || "研究底稿"} · 缺失值留空
        </text>
      </svg>
      <div className="chart-downloads">
        <button onClick={() => download("png")}>
          <DownloadSimple size={13} /> PNG
        </button>
        <button onClick={() => download("svg")}>SVG</button>
        <button onClick={() => download("csv")}>数据 CSV</button>
      </div>
    </div>
  );
}
