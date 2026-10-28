import { useEffect, useRef, useState } from "react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;

/** Use PDF.js compatibility builds in both realms for Safari web apps. */
export default function PDFPage({ url, page }: { url: string; page: number }) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [width, setWidth] = useState(500),
    [current, setCurrent] = useState(page),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => setCurrent(page), [page]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, entries[0].contentRect.width)),
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    setError("");
    setDoc(null);
    const task = getDocument({
      url,
      cMapUrl: "/api/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/api/pdf-assets/standard_fonts/",
    });
    task.promise
      .then((pdf) => {
        if (live) setDoc(pdf);
      })
      .catch((e) => {
        if (live) setError("原文页加载失败：" + e.message);
      });
    return () => {
      live = false;
      task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!doc) return;
    let live = true,
      renderTask: any;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const number = Math.min(Math.max(1, current), doc.numPages),
          pdfPage = await doc.getPage(number);
        if (!live || !canvas.current) return;
        const base = pdfPage.getViewport({ scale: 1 }),
          scale = width / base.width,
          ratio = Math.min(window.devicePixelRatio || 1, 2),
          viewport = pdfPage.getViewport({ scale: scale * ratio }),
          target = canvas.current;
        target.width = viewport.width;
        target.height = viewport.height;
        target.style.width = width + "px";
        target.style.height = viewport.height / ratio + "px";
        renderTask = pdfPage.render({
          canvas: target,
          canvasContext: target.getContext("2d")!,
          viewport,
        });
        await renderTask.promise;
        if (live) setLoading(false);
      } catch (e: any) {
        if (live && e.name !== "RenderingCancelledException") {
          setError("原文页渲染失败：" + e.message);
          setLoading(false);
        }
      }
    })();
    return () => {
      live = false;
      renderTask?.cancel();
    };
  }, [doc, current, width]);
  return (
    <div className="pdf-page-viewer">
      <div className="pdf-page-toolbar">
        <button
          disabled={!doc || current <= 1}
          onClick={() => setCurrent((p) => p - 1)}
        >
          上一页
        </button>
        <span>
          物理页 {current}
          {doc ? " / " + doc.numPages : ""}
        </span>
        <button
          disabled={!doc || current >= doc.numPages}
          onClick={() => setCurrent((p) => p + 1)}
        >
          下一页
        </button>
      </div>
      {error ? (
        <p className="inline-error">{error}</p>
      ) : (
        <>
          {loading && <p className="muted small">正在读取原文页…</p>}
          <div ref={host} className="pdf-canvas-host">
            <canvas
              ref={canvas}
              role="img"
              aria-label={"财报原文第" + current + "页"}
            />
          </div>
        </>
      )}
    </div>
  );
}
