"""FastAPI HTTP适配层：保持原React前端的URL、JSON字段与SSE协议。

路由只接收用户操作并调用应用服务；Agent控制流在agent/loop.py。
"""

import asyncio
import os
from contextlib import asynccontextmanager
from urllib.parse import quote, urlsplit
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from .common import AppError, clone, dumps, now
from .memory.store import Store, public_chat
from .trace.session_store import SessionStore
from .llm.model import ModelClient
from .tools.finance import FinanceProvider
from .tools.documents import add_document, evidence, refs
from .research.artifacts import scenario_result, financial_chart, make_card, mark_stale
from .research.metrics import operating_chart
from .reports.service import ReportService, accept_revision
from .reports.export import export_markdown
from .agent.application import ResearchApplication
from .context.assembler import ROOT


async def body(request):
    try:
        return await request.json()
    except ValueError:
        raise AppError("请求内容不是有效JSON")


def create_app(data_dir=None, transport=None, finance=None, recover=True):
    """启动器/测试调用工厂；只在显式构造时打开数据，不在模块导入时恢复任务。"""
    store = Store(data_dir or os.getenv("CHAT_DATA_DIR") or ROOT / "data")
    sessions = SessionStore(store)
    client = transport or ModelClient(store.settings)
    controls = {}
    research = ResearchApplication(
        sessions, client, finance or FinanceProvider(), controls
    )
    reports = ReportService(sessions, client, controls)

    @asynccontextmanager
    async def lifespan(app):
        if recover:
            sessions.recover_interrupted()
        yield
        await research.shutdown()
        # 未结束的报告调用也收到停止信号，由请求协程完成清理。
        for token in list(controls.values()):
            token.cancel()
        store.db.close()

    app = FastAPI(
        title="研迹", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
    )
    app.state.store, app.state.sessions, app.state.research, app.state.reports = (
        store,
        sessions,
        research,
        reports,
    )

    @app.middleware("http")
    async def local_access(request, call_next):
        # 本机应用没有公网账户系统；拒绝陌生Host和跨站写入。
        host = request.url.hostname
        if host not in ("localhost", "127.0.0.1", "::1"):
            return Response(status_code=403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("x-yanji-client") != "1":
                return JSONResponse({"error": "请从研迹页面操作"}, 403)
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.headers.get("host"):
                return Response(status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(AppError)
    async def business_error(request, error):
        return JSONResponse({"error": str(error)}, status_code=error.status)

    @app.exception_handler(Exception)
    async def unexpected_error(request, error):
        # 网络底层错误可能带请求信息，不把鉴权头和内部堆栈发到页面。
        return JSONResponse(
            {"error": "操作未完成，请重试或查看执行记录"}, status_code=400
        )

    @app.get("/api/settings")
    async def settings():
        return store.public_settings()

    @app.put("/api/settings")
    async def save_settings(request: Request):
        return store.save_settings(await body(request))

    @app.post("/api/settings/test")
    async def test_settings():
        await client([dict(role="user", content="请回复连接成功")], max_tokens=50)
        return {"ok": True}

    @app.get("/api/chats")
    async def chats(includeArchived: str = ""):
        return [
            dict(
                id=c["id"],
                title=c["title"],
                updatedAt=c["updatedAt"],
                messageCount=len(c["messages"]),
                archived=bool(c.get("archived")),
            )
            for c in store.list()
            if includeArchived == "1" or not c.get("archived")
        ]

    @app.post("/api/chats")
    async def create_chat():
        return public_chat(store.create())

    @app.get("/api/chats/{cid}")
    async def chat(cid: str):
        return public_chat(store.get(cid))

    @app.patch("/api/chats/{cid}")
    async def edit_chat(cid: str, request: Request):
        data = await body(request)
        chat = store.get(cid)
        if isinstance(data.get("title"), str) and data["title"].strip():
            chat["title"] = data["title"].strip()[:120]
        if isinstance(data.get("archived"), bool):
            if data["archived"] and any(r["status"] == "running" for r in chat["runs"]):
                raise AppError("请先停止正在运行的研究再归档")
            chat.update(
                archived=data["archived"],
                archivedAt=now() if data["archived"] else None,
            )
        return public_chat(store.put(chat))

    @app.get("/api/chats/{cid}/runs/{rid}/trace")
    async def trace(cid: str, rid: str):
        return sessions.read_trace(cid, rid)

    @app.get("/api/chats/{cid}/events")
    async def events(cid: str, request: Request):
        store.get(cid)

        async def stream():
            last = None
            while not await request.is_disconnected():
                value = dumps(public_chat(store.get(cid)))
                if value != last:
                    yield "data: " + value + "\n\n"
                    last = value
                else:
                    yield ": keepalive\n\n"
                await asyncio.sleep(0.45)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/chats/{cid}/messages")
    async def messages(cid: str, request: Request):
        data = await body(request)
        return research.start(
            cid,
            data.get("text"),
            {k: data[k] for k in ("skillId", "sourceMode") if k in data},
        )

    @app.post("/api/chats/{cid}/runs/{rid}/stop")
    async def stop(cid: str, rid: str):
        research.stop(cid, rid)
        return {"ok": True}

    @app.post("/api/chats/{cid}/documents")
    async def upload(cid: str, request: Request):
        chat = store.get(cid)
        if any(r["status"] == "running" for r in chat["runs"]):
            raise AppError("请在当前研究结束后导入材料")
        form = await request.form(
            max_files=1, max_fields=10, max_part_size=31 * 1024 * 1024
        )
        file = form.get("file")
        if not file or not hasattr(file, "read"):
            raise AppError("请选择文件")
        try:
            content = await file.read(30 * 1024 * 1024 + 1)
            if len(content) > 30 * 1024 * 1024:
                raise AppError("文件超过30MB")
            name = file.filename or "材料"
            # CPU解析放到线程，避免大PDF阻塞其余对话的SSE和停止按钮。
            result = await asyncio.to_thread(
                add_document, chat, content, name, store.data_dir
            )
        finally:
            await file.close()
        if not result["duplicate"]:
            fresh = store.get(cid)
            if any(r["status"] == "running" for r in fresh["runs"]):
                raise AppError("研究已开始，请结束后重新导入")
            if not any(
                d["hash"] == result["document"]["hash"] for d in fresh["documents"]
            ):
                fresh["documents"].append(result["document"])
                fresh["revision"] += 1
                store.put(fresh)
            chat = fresh
        return public_chat(chat)

    @app.get("/api/chats/{cid}/documents/{did}/file")
    async def document_file(cid: str, did: str):
        document = next(
            (d for d in store.get(cid)["documents"] if d["id"] == did), None
        )
        if not document:
            raise AppError("材料不存在", 404)
        file = (store.data_dir / "files" / document["file"]).resolve()
        if file.parent != (store.data_dir / "files").resolve() or not file.is_file():
            raise AppError("原文件不存在", 404)
        return FileResponse(
            file,
            headers={
                "Content-Disposition": "inline; filename*=UTF-8''"
                + quote(document["name"])
            },
            media_type="application/pdf" if document["type"] == "pdf" else None,
        )

    @app.get("/api/chats/{cid}/documents/{did}/page/{page}")
    async def document_page(cid: str, did: str, page: int):
        document = next(
            (d for d in store.get(cid)["documents"] if d["id"] == did), None
        )
        if not document or not 1 <= page <= len(document["pages"]):
            raise AppError("原文页不存在", 404)
        chunk = next((c for c in document["chunks"] if c["page"] == page), {})
        return {
            **chunk,
            "id": f"{did}:{page}:0",
            "documentId": did,
            "name": document["name"],
            "page": page,
            "type": document["type"],
            "date": document["date"],
            "text": chunk.get("text")
            or document["pages"][page - 1].get("text")
            or "此页没有可提取文字，请查看PDF原文。",
        }

    @app.get("/api/chats/{cid}/sources/{sid}")
    async def source(cid: str, sid: str):
        source = evidence(store.get(cid), sid)
        if not source:
            raise AppError("来源不存在", 404)
        return source

    @app.patch("/api/chats/{cid}/cards/{card_id}")
    async def edit_card(cid: str, card_id: str, request: Request):
        data = await body(request)
        selection_only = set(data).issubset({"revision", "selected"}) and isinstance(
            data.get("selected"), bool
        )
        revision = (
            store.get(cid)["revision"] if selection_only else data.get("revision")
        )

        def change(chat):
            card = next((c for c in chat["cards"] if c["id"] == card_id), None)
            if not card:
                raise AppError("卡片不存在")
            if isinstance(data.get("selected"), bool):
                card["selected"] = data["selected"]
            changed = False
            if isinstance(data.get("title"), str) and data["title"].strip():
                card["title"] = data["title"].strip()[:200]
                changed = True
                if card["kind"] == "chart":
                    card["data"]["title"] = card["title"]
            if isinstance(data.get("body"), str) and card["kind"] == "brief":
                if any(not evidence(chat, s) for s in refs(data["body"])):
                    raise AppError("内容含失效来源")
                card["data"]["body"] = data["body"][:10000]
                changed = True
            if isinstance(data.get("notes"), str):
                card["data"]["notes"] = data["notes"][:3000]
                changed = True
            if data.get("kind") and card["kind"] == "chart":
                if data["kind"] not in ("line", "bar"):
                    raise AppError("不支持该图型")
                card["data"]["kind"] = data["kind"]
                changed = True
            if data.get("input") and card["kind"] == "scenario":
                inputs = data["input"]
                if inputs.get("baseRevenue") != card["data"]["input"]["baseRevenue"]:
                    raise AppError("历史收入基准不可改，请重新选择财务来源")
                card["data"].update(input=inputs, rows=scenario_result(inputs))
                from .common import uid

                source = dict(
                    id="S" + uid().replace("-", ""),
                    documentId="",
                    name="用户修改的情景假设",
                    type="web",
                    page=1,
                    date=now(),
                    sourceUrl="",
                    data={
                        **clone(card["data"]),
                        "growthRate": inputs["growth"],
                        "grossMargin": inputs["margin"],
                    },
                )
                source["text"] = dumps(source["data"])
                chat["researchSources"].append(source)
                card["sourceIds"] = [card["sourceIds"][0], source["id"]]
                changed = True
            if changed:
                card["version"] += 1
                card["editedAt"] = now()
                mark_stale(chat, card_id)

        return public_chat(store.edit(cid, revision, change))

    @app.post("/api/chats/{cid}/cards/{card_id}/chart")
    async def chart(cid: str, card_id: str, request: Request):
        data = await body(request)

        def change(chat):
            card = next((c for c in chat["cards"] if c["id"] == card_id), None)
            if not card or card["kind"] not in ("financials", "worksheet"):
                raise AppError("请从财务表或经营底稿生成图表")
            metric = str(data.get("metric") or "revenue")
            row_id, _, view = metric.partition(":")
            result = (
                operating_chart(card["data"], row_id, view or "annual")
                if card["kind"] == "worksheet"
                else financial_chart(
                    card["data"], card["sourceIds"][0], metric, data.get("kind", "line")
                )
            )
            from .common import unique

            ids = (
                unique(s for r in result["rows"] for s in r.get("sourceIds", []))
                if card["kind"] == "worksheet"
                else card["sourceIds"]
            )
            chart = make_card("chart", result["title"], result, ids)
            chat["cards"].append(chart)
            message = next(
                (m for m in chat["messages"] if card_id in m.get("cardIds", [])), None
            )
            if not message:
                raise AppError("研究产物未关联对话消息")
            message["cardIds"].append(chart["id"])

        return public_chat(store.edit(cid, data.get("revision"), change))

    @app.post("/api/chats/{cid}/compile")
    async def compile(cid: str, request: Request):
        data = await body(request)
        return public_chat(await reports.compile(cid, data.get("format") or "full"))

    @app.post("/api/chats/{cid}/report/research")
    async def report_research(cid: str, request: Request):
        data = await body(request)
        return research.start(
            cid,
            data.get("instruction"),
            dict(mode="revision", sectionId=data.get("sectionId")),
        )

    @app.post("/api/chats/{cid}/revisions/{card_id}/accept")
    async def accept(cid: str, card_id: str):
        return public_chat(accept_revision(store, cid, card_id))

    @app.post("/api/chats/{cid}/report/revise")
    async def revise(cid: str, request: Request):
        data = await body(request)
        return await reports.revise(cid, data.get("sectionId"), data.get("instruction"))

    @app.patch("/api/chats/{cid}/report")
    async def edit_report(cid: str, request: Request):
        data = await body(request)

        def change(chat):
            report = chat.get("report")
            if not report:
                raise AppError("尚无研报")
            if report["version"] != data.get("version"):
                raise AppError("文档已被修改，请刷新", 409)
            section = next(
                (s for s in report["sections"] if s["id"] == data.get("sectionId")),
                None,
            )
            if not section:
                raise AppError("章节不存在")
            content = str(data.get("content") or "")[:30000]
            if any(not evidence(chat, s) for s in refs(content)):
                raise AppError("章节中有失效来源")
            chat["reports"].append(clone(report))
            section["content"] = content
            report["version"] += 1
            report["at"] = now()

        return public_chat(store.edit(cid, data.get("revision"), change))

    @app.get("/api/chats/{cid}/export")
    async def export(cid: str):
        chat = store.get(cid)
        text = export_markdown(chat)
        return Response(
            text,
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(chat["report"]["title"] + ".md")
            },
        )

    @app.api_route(
        "/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"]
    )
    async def unknown_api(rest: str):
        raise AppError("接口不存在", 404)

    # PDF阅读器仍由前端pdfjs渲染；这里只提供其字体与CMap静态资源。
    pdf_assets = ROOT / "node_modules/pdfjs-dist"
    # API catch-all前挂载，确保阅读器的附加资源不会误入404接口。
    from starlette.routing import Mount

    for name in ("cmaps", "standard_fonts"):
        if (pdf_assets / name).is_dir():
            app.router.routes.insert(
                0,
                Mount(
                    "/api/pdf-assets/" + name,
                    app=StaticFiles(directory=pdf_assets / name),
                ),
            )
    if (ROOT / "dist").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
    return app
