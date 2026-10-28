"""工具执行→暂存→验证→原子提交。失败不能留下半张有效底稿。"""

import asyncio
from ..common import AppError, clone, dumps, now, uid
from ..verification.verifier import NoopVerifier, VerificationRejected

BUSINESS_FIELDS = (
    "cards",
    "messages",
    "researchSources",
    "documentAnalysisCache",
    "researchPlan",
)


class Workspace:
    """每个工具独享一份会话副本；工具通过这里写候选，不接触真实数据库。"""

    def __init__(self, context):
        self.context = context
        self.base = context["sessions"].snapshot(context["cid"])
        self.chat = clone(self.base)
        self.seen = set(context["seen"])
        self.calculations = clone(context["calculations"])
        self.financial_cache = set(context.get("financial_cache", set()))

    def source(self, data, name):
        """业务工具在草稿副本添加来源；未验证前不进入真实会话。"""
        source = dict(
            id="S" + uid().replace("-", ""),
            documentId="",
            name=name,
            type="web",
            page=1,
            date=now(),
            sourceUrl=data.get("sourceUrl", ""),
            text=dumps(data),
            data=clone(data),
        )
        self.chat["researchSources"].append(source)
        return source

    def artifact(self, card):
        """业务工具暂存产物并关联当前助手消息；不直接提交数据库。"""
        self.chat["cards"].append(card)
        message = next(
            (
                m
                for m in self.chat["messages"]
                if m["id"] == self.context["run"]["messageId"]
            ),
            None,
        )
        if not message:
            raise AppError("任务消息不存在")
        message["cardIds"].append(card["id"])
        return card

    def event(self, label, detail=""):
        """业务工具报告进度；仅写遥测，不提前发布候选内容。"""
        self.context["sessions"].event(
            self.context["cid"], self.context["run"]["id"], label, detail
        )

    def progress(self, index, patch):
        docs = self.chat["documents"]

        def change(_, run):
            if "documentProgress" not in run:
                run["documentProgress"] = [
                    dict(
                        id=d["id"],
                        name=d["name"],
                        status="queued",
                        pages=len(d["pages"]),
                    )
                    for d in docs
                ]
            run["documentProgress"][index].update(patch)

        self.context["sessions"].update(
            self.context["cid"], self.context["run"]["id"], change
        )


class ToolExecutionPipeline:
    """Registry 调用；只管理副作用顺序，不包含工具业务或模型提示词。"""

    def __init__(self, context, verifier=None):
        self.context = context
        self.verifier = verifier or NoopVerifier()
        self.lock = asyncio.Lock()

    async def run(self, entry, args, metadata, handler):
        """Registry调用本流水线；先验证候选，再委托SessionStore提交，不在验证器中改数据。"""
        async with self.lock:
            context = self.context
            sessions = context["sessions"]
            cid = context["cid"]
            rid = context["run"]["id"]
            token = metadata.get("token") or context["token"]
            token.check()
            workspace = Workspace(context)
            call_id = metadata.get("callId") or uid()
            local = {
                **context,
                "workspace": workspace,
                "seen": workspace.seen,
                "calculations": workspace.calculations,
                "financial_cache": workspace.financial_cache,
                "token": token,
                "model": context["model"].scope(
                    parentCallId=call_id, purpose=entry["name"]
                ),
            }
            try:
                data = await handler(args, local)
                token.check()
                if isinstance(data, dict) and data.get("error"):
                    raise AppError(str(data["error"]))
                protected = (
                    set(workspace.chat)
                    - set(BUSINESS_FIELDS)
                    - {"runs", "revision", "updatedAt"}
                )
                if any(
                    workspace.chat.get(k) != workspace.base.get(k) for k in protected
                ):
                    raise AppError("工具试图修改受保护的会话状态")
                # 验证器看到的是候选快照，不能悄悄修改实际提交内容。
                sources = _sources_from_candidate(workspace, data)
                verdict = await self.verifier.verify(
                    dict(
                        callId=call_id,
                        toolName=entry["name"],
                        data=clone(data),
                        sources=sources,
                        status="candidate",
                        pendingArtifacts=clone(
                            workspace.chat["cards"][len(workspace.base["cards"]) :]
                        ),
                    ),
                    dict(
                        sessionId=cid,
                        runId=rid,
                        task={"goal": context["run"]["question"]},
                    ),
                )
                token.check()
                if verdict.get("accepted") is not True:
                    raise VerificationRejected(verdict.get("reason") or "验证未通过")
                sessions.commit_tool(
                    cid,
                    rid,
                    workspace.base,
                    workspace.chat,
                    dict(
                        callId=call_id,
                        name=entry["name"],
                        status="accepted",
                        data=clone(data),
                        sourceIds=[s["id"] for s in sources],
                    ),
                )
                context["seen"].clear()
                context["seen"].update(workspace.seen)
                context["calculations"][:] = workspace.calculations
                context["financial_cache"].clear()
                context["financial_cache"].update(workspace.financial_cache)
                return data
            except Exception as error:
                sessions.audit(
                    cid,
                    rid,
                    dict(
                        callId=call_id,
                        name=entry["name"],
                        status="rejected"
                        if getattr(error, "code", None) == "VERIFICATION_REJECTED"
                        else "cancelled"
                        if token.cancelled
                        else "error",
                        error=dict(
                            code=getattr(error, "code", type(error).__name__),
                            message=str(error),
                        ),
                    ),
                )
                raise


def _sources_from_candidate(workspace, data):
    from .documents import evidence

    ids = set()

    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get("sourceId"), str):
                ids.add(value["sourceId"])
            ids.update(value.get("sourceIds") or [])
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(data)
    walk(workspace.chat["cards"][len(workspace.base["cards"]) :])
    result = []
    for sid in sorted(ids):
        source = evidence(workspace.chat, sid)
        result.append(
            dict(
                id=sid,
                kind="document"
                if source and source.get("documentId")
                else "external"
                if source
                else "unknown",
                label=source.get("name", sid) if source else sid,
                page=source.get("page") if source else None,
            )
        )
    return result
