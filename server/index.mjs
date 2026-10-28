import { sessionStore } from "./trace/runtime-store.mjs";
import { operatingChart } from "./research/operating-series.mjs";
import { createRequire } from "node:module";
import { acceptRevision } from "./reports/revisions.mjs";
import express from "express";
import { exportMarkdown } from "./reports/export.mjs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  id,
  now,
  dataDir,
  listChats,
  getProject,
  putProject,
  createChat,
  edit,
  publicChat,
  publicSettings,
  saveSettings,
} from "./memory/store.mjs";
import { addDocument, evidence, refs } from "./tools/documents/documents.mjs";
import { start, stop, addSource } from "./agent/research-agent.mjs";
import { compileReport, reviseSection } from "./reports/writer.mjs";
import {
  scenarioResult,
  financialChart,
  makeCard,
  markReportStale,
} from "./research/artifacts.mjs";
import { model } from "./llm/client.mjs";
export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  if (!["localhost", "127.0.0.1", "::1"].includes(req.hostname))
    return res.status(403).end();
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.get("x-yanji-client") !== "1")
      return res.status(403).json({ error: "请从研迹页面操作" });
    const origin = req.get("origin");
    if (origin && new URL(origin).host !== req.get("host"))
      return res.status(403).end();
  }
  next();
});
app.use(express.json({ limit: "4mb" }));
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(e);
  }
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
});
app.get("/api/settings", (req, res) => res.json(publicSettings()));
app.put(
  "/api/settings",
  route((req, res) => res.json(saveSettings(req.body))),
);
app.post(
  "/api/settings/test",
  route(async (req, res) => {
    await model([{ role: "user", content: "请回复连接成功" }], {
      maxTokens: 50,
    });
    res.json({ ok: true });
  }),
);
app.get("/api/chats", (req, res) =>
  res.json(
    listChats()
      .filter((c) => req.query.includeArchived === "1" || !c.archived)
      .map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
        archived: !!c.archived,
      })),
  ),
);
app.post(
  "/api/chats",
  route((req, res) => res.json(publicChat(createChat()))),
);
app.patch(
  "/api/chats/:cid",
  route((req, res) => {
    const c = getProject(req.params.cid);
    if (typeof req.body.title === "string" && req.body.title.trim())
      c.title = req.body.title.trim().slice(0, 120);
    if (typeof req.body.archived === "boolean") {
      if (req.body.archived && c.runs.some((r) => r.status === "running"))
        throw new Error("请先停止正在运行的研究再归档");
      c.archived = req.body.archived;
      c.archivedAt = c.archived ? now() : null;
    }
    putProject(c);
    res.json(publicChat(c));
  }),
);
app.get(
  "/api/chats/:cid",
  route((req, res) => res.json(publicChat(getProject(req.params.cid)))),
);
app.get(
  "/api/chats/:cid/runs/:rid/trace",
  route((req, res) => res.json(sessionStore.readTrace(req.params.cid, req.params.rid))),
);
app.get(
  "/api/chats/:cid/events",
  route((req, res) => {
    getProject(req.params.cid);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    let last = "";
    const send = () => {
      try {
        const c = getProject(req.params.cid);
        const value = JSON.stringify(publicChat(c));
        if (value !== last) {
          last = value;
          res.write("data: " + value + "\n\n");
        }
      } catch {
        res.end();
      }
    };
    send();
    const timer = setInterval(send, 450);
    req.on("close", () => clearInterval(timer));
  }),
);
app.post(
  "/api/chats/:cid/messages",
  route((req, res) =>
    res.json(
      start(req.params.cid, req.body.text, {
        sourceMode: req.body.sourceMode,
        skillId: req.body.skillId,
      }),
    ),
  ),
);
app.post(
  "/api/chats/:cid/runs/:rid/stop",
  route((req, res) => {
    stop(req.params.cid, req.params.rid);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/chats/:cid/documents",
  upload.single("file"),
  route(async (req, res) => {
    let c = getProject(req.params.cid);
    if (c.runs.some((r) => r.status === "running"))
      throw new Error("请在当前研究结束后导入材料");
    if (!req.file) throw new Error("请选择文件");
    let name = req.file.originalname;
    try {
      name = Buffer.from(name, "latin1").toString("utf8");
    } catch {}
    const result = await addDocument(c, req.file.buffer, name, "");
    if (!result.duplicate) {
      const fresh = getProject(c.id);
      if (!fresh.documents.some((d) => d.hash === result.document.hash)) {
        fresh.documents.push(result.document);
        fresh.revision++;
        putProject(fresh);
      }
      c = fresh;
    }
    res.json(publicChat(c));
  }),
);
app.get(
  "/api/chats/:cid/documents/:did/file",
  route((req, res) => {
    const c = getProject(req.params.cid),
      d = c.documents.find((d) => d.id === req.params.did);
    if (!d) return res.status(404).end();
    res.set(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    );
    res.sendFile(path.join(dataDir, "files", d.file));
  }),
);
app.get(
  "/api/chats/:cid/documents/:did/page/:page",
  route((req, res) => {
    const c = getProject(req.params.cid),
      d = c.documents.find((d) => d.id === req.params.did),
      page = Number(req.params.page);
    if (!d || !Number.isInteger(page) || page < 1 || page > d.pages.length)
      return res.status(404).json({ error: "原文页不存在" });
    const chunk = d.chunks.find((s) => s.page === page);
    res.json({
      ...chunk,
      id: d.id + ":" + page + ":0",
      documentId: d.id,
      name: d.name,
      page,
      type: d.type,
      date: d.date,
      text:
        chunk?.text ||
        d.pages[page - 1]?.text ||
        "此页没有可提取文字，请查看PDF原文。",
    });
  }),
);
app.get(
  "/api/chats/:cid/sources/:sid",
  route((req, res) => {
    const s = evidence(getProject(req.params.cid), req.params.sid);
    if (!s) return res.status(404).json({ error: "来源不存在" });
    res.json(s);
  }),
);
app.patch(
  "/api/chats/:cid/cards/:cardId",
  route((req, res) => {
    const { revision, selected, title, body, notes, kind, input } = req.body;
    const selectionOnly =
      Object.keys(req.body).every((k) =>
        ["revision", "selected"].includes(k),
      ) && typeof selected === "boolean";
    const baseRevision = selectionOnly
      ? getProject(req.params.cid).revision
      : revision;
    const c = edit(req.params.cid, baseRevision, (c) => {
      const card = c.cards.find((x) => x.id === req.params.cardId);
      if (!card) throw new Error("卡片不存在");
      if (typeof selected === "boolean") card.selected = selected;
      let changed = false;
      if (typeof title === "string" && title.trim()) {
        card.title = title.trim().slice(0, 200);
        if (card.kind === "chart") card.data.title = card.title;
        changed = true;
      }
      if (typeof body === "string" && card.kind === "brief") {
        for (const eid of refs(body))
          if (!evidence(c, eid)) throw new Error("内容含失效来源");
        card.data.body = body.slice(0, 10000);
        changed = true;
      }
      if (typeof notes === "string") {
        card.data.notes = notes.slice(0, 3000);
        changed = true;
      }
      if (kind && card.kind === "chart") {
        if (!["line", "bar"].includes(kind)) throw new Error("不支持该图型");
        card.data.kind = kind;
        changed = true;
      }
      if (input && card.kind === "scenario") {
        if (input.baseRevenue !== card.data.input.baseRevenue)
          throw new Error("历史收入基准不可改，请重新选择财务来源");
        const rows = scenarioResult(input);
        card.data.input = input;
        card.data.rows = rows;
        const source = addSource(
          c.id,
          { ...card.data, growthRate: input.growth, grossMargin: input.margin },
          "用户修改的情景假设",
        );
        c.researchSources.push(source);
        card.sourceIds = [card.sourceIds[0], source.id];
        changed = true;
      }
      if (changed) {
        card.version++;
        card.editedAt = now();
        markReportStale(c, card.id);
      }
    });
    res.json(publicChat(c));
  }),
);
app.post(
  "/api/chats/:cid/cards/:cardId/chart",
  route((req, res) => {
    const c = edit(req.params.cid, req.body.revision, (c) => {
      const card = c.cards.find((x) => x.id === req.params.cardId);
      if (!["financials", "worksheet"].includes(card?.kind))
        throw new Error("请从财务表或经营底稿生成图表");
      const [rowId, view] = String(req.body.metric || "").split(":");
      const data =
        card.kind === "worksheet"
          ? operatingChart(card.data, rowId, view || "annual")
          : financialChart(
              card.data,
              card.sourceIds[0],
              req.body.metric || "revenue",
              req.body.kind || "line",
            );
      const chartSources =
        card.kind === "worksheet"
          ? [...new Set(data.rows.flatMap((r) => r.sourceIds))]
          : card.sourceIds;
      const chart = makeCard("chart", data.title, data, chartSources);
      c.cards.push(chart);
      const message = c.messages.find((m) => m.cardIds?.includes(card.id));
      message.cardIds.push(chart.id);
    });
    res.json(publicChat(c));
  }),
);
app.post(
  "/api/chats/:cid/compile",
  route(async (req, res) =>
    res.json(publicChat(await compileReport(req.params.cid, req.body.format))),
  ),
);
app.post(
  "/api/chats/:cid/report/research",
  route((req, res) =>
    res.json(
      start(req.params.cid, req.body.instruction, {
        mode: "revision",
        sectionId: req.body.sectionId,
      }),
    ),
  ),
);
app.post(
  "/api/chats/:cid/revisions/:cardId/accept",
  route((req, res) =>
    res.json(publicChat(acceptRevision(req.params.cid, req.params.cardId))),
  ),
);
app.post(
  "/api/chats/:cid/report/revise",
  route(async (req, res) =>
    res.json(
      await reviseSection(
        req.params.cid,
        req.body.sectionId,
        req.body.instruction,
      ),
    ),
  ),
);
app.patch(
  "/api/chats/:cid/report",
  route((req, res) => {
    const c = edit(req.params.cid, req.body.revision, (c) => {
      if (!c.report) throw new Error("尚无研报");
      if (c.report.version !== req.body.version)
        throw Object.assign(new Error("文档已被修改，请刷新"), { status: 409 });
      const section = c.report.sections.find(
        (s) => s.id === req.body.sectionId,
      );
      if (!section) throw new Error("章节不存在");
      const content = String(req.body.content || "").slice(0, 30000);
      for (const eid of refs(content))
        if (!evidence(c, eid)) throw new Error("章节中有失效来源");
      c.reports.push(structuredClone(c.report));
      section.content = content;
      c.report.version++;
      c.report.at = now();
    });
    res.json(publicChat(c));
  }),
);
app.get(
  "/api/chats/:cid/export",
  route((req, res) => {
    const c = getProject(req.params.cid);
    const md = exportMarkdown(c);
    res.set({
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(c.report.title + ".md")}`,
    });
    res.send(md);
  }),
);
const pdfAssets = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
app.use("/api/pdf-assets/cmaps", express.static(path.join(pdfAssets, "cmaps")));
app.use(
  "/api/pdf-assets/standard_fonts",
  express.static(path.join(pdfAssets, "standard_fonts")),
);
app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
app.use((e, req, res, next) =>
  res.status(e.status || 400).json({
    error:
      e.code === "LIMIT_FILE_SIZE" ? "文件超过30MB" : e.message || "操作失败",
  }),
);
export async function startServer(port = Number(process.env.PORT) || 4320) {
  sessionStore.recoverInterrupted();
  if (process.env.NODE_ENV === "production") {
    app.use(express.static(path.resolve("dist")));
    app.get("/{*path}", (req, res) =>
      res.sendFile(path.resolve("dist/index.html")),
    );
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }
  return app.listen(port, "127.0.0.1", () =>
    console.log(`研迹对话版 http://127.0.0.1:${port}`),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startServer();
