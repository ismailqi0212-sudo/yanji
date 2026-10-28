import { lazy, Suspense } from "react";
const PDFPage = lazy(() => import("./PDFPage"));
import { X, ArrowSquareOut } from "@phosphor-icons/react";
import type { Source } from "../types";
import { FinancialTable } from "./Cards";
export default function EvidencePanel({
  source,
  cid,
  onClose,
}: {
  source: Source;
  cid: string;
  onClose: () => void;
}) {
  const fileUrl = source.documentId
    ? "/api/chats/" +
      cid +
      "/documents/" +
      source.documentId +
      "/file#page=" +
      source.page
    : "";
  return (
    <aside className="evidence-panel">
      <header>
        <div>
          <b>原文与依据</b>
          <span>{source.name}</span>
        </div>
        <button aria-label="关闭原文" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="evidence-body">
        <div className="source-meta">
          <span>
            {source.type === "pdf" ? "PDF物理页 " + source.page : "数据快照"}
          </span>
          <span>{source.date?.slice(0, 10)}</span>
        </div>
        {source.type === "pdf" && fileUrl ? (
          <>
            <Suspense
              fallback={<p className="muted small">正在加载原文阅读器…</p>}
            >
              <PDFPage url={fileUrl.split("#")[0]} page={source.page} />
            </Suspense>
            <details>
              <summary>查看提取的文字</summary>
              <pre className="source-text">{source.text}</pre>
            </details>
          </>
        ) : source.data?.rows?.some((r: any) => "revenue" in r) ? (
          <>
            <FinancialTable
              data={source.data}
              sourceId={source.id}
              onSource={() => {}}
            />
            <details className="raw-source">
              <summary>原始数据及申报字段</summary>
              <pre className="source-text">{source.text}</pre>
            </details>
          </>
        ) : (
          <pre className="source-text">{source.text}</pre>
        )}
        {source.sourceUrl ? (
          <a
            className="source-original"
            href={source.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            打开数据源 <ArrowSquareOut size={13} />
          </a>
        ) : (
          fileUrl && (
            <a
              className="source-original"
              href={fileUrl}
              target="_blank"
              rel="noreferrer"
            >
              单独打开原文件 <ArrowSquareOut size={13} />
            </a>
          )
        )}
      </div>
    </aside>
  );
}
