"""从用户确认材料组稿；探索阶段和正式报告之间有明确的确认边界。"""

import re
from ..common import AppError, clone, now, uid, unique
from ..context.assembler import ASSETS, ContextAssembler, report_messages
from ..tools.registry import ToolRegistry
from ..tools.documents import evidence, refs
from ..research.artifacts import make_card, financial_comparisons
from ..research.plan import remember_gaps
from ..research.validation import review_draft, validate_answer
from ..verification.verifier import NoopVerifier, VerificationRejected
from ..agent.runtime_factory import AgentRuntimeFactory
from ..agent.cancellation import CancellationToken
from ..llm.model import ModelService


def report_computations(chat, cards, source_ids):
    comparisons = clone(cards)
    for sid in source_ids:
        source = evidence(chat, sid)
        if (
            source
            and source.get("data", {}).get("rows")
            and source["data"].get("frequency")
            and not any(
                c["kind"] == "financials" and sid in c["sourceIds"] for c in cards
            )
        ):
            comparisons.append(
                dict(kind="financials", data=source["data"], sourceIds=[sid])
            )
    return [
        *financial_comparisons(comparisons),
        *[
            record["result"]
            for run in chat["runs"]
            for record in run.get("records", [])
            if record["name"] == "calculate"
            and isinstance(record.get("result"), dict)
            and "result" in record["result"]
            and record["result"].get("sourceIds")
            and all(s in source_ids for s in record["result"]["sourceIds"])
        ],
    ]


def propose_revision(args, context):
    workspace = context["workspace"]
    chat = workspace.chat
    run = context["run"]
    report = chat.get("report")
    if not report or report["version"] != run.get("baseReportVersion"):
        raise AppError("研报版本已变化，请基于最新章节重新发起补查")
    if args["sectionId"] != run["sectionId"]:
        raise AppError("只能修改本次指定章节")
    section = next(
        (s for s in report["sections"] if s["id"] == args["sectionId"]), None
    )
    if not section:
        raise AppError("章节不存在")
    ids = unique([*args.get("sourceIds", []), *refs(args.get("content"))])
    if not ids:
        raise AppError("修改建议必须关联已读取的证据")
    content = args["content"]
    if not refs(content):
        content += "\n\n" + " ".join(
            f"[依据{i + 1}](evidence:{sid})" for i, sid in enumerate(ids)
        )
    valid = validate_answer(
        chat,
        dict(answer=content, sourceIds=ids),
        context["seen"],
        [
            *context["calculations"],
            *report_computations(
                chat,
                [c for c in chat["cards"] if any(s in ids for s in c["sourceIds"])],
                ids,
            ),
        ],
    )
    card = workspace.artifact(
        make_card(
            "revision",
            "章节修改建议 · " + section["title"],
            dict(
                sectionId=section["id"],
                sectionTitle=args.get("title") or section["title"],
                baseVersion=report["version"],
                before=section["content"],
                body=valid["answer"],
                reason=str(args.get("reason", "")),
                remainingGaps=args.get("remainingGaps", []),
                status="pending",
                dependencyVersions={
                    c["id"]: c["version"]
                    for c in chat["cards"]
                    if any(s in ids for s in c["sourceIds"])
                },
            ),
            valid["sourceIds"],
        )
    )
    remember_gaps(chat, run, args.get("remainingGaps", []))
    return dict(
        done=True,
        cardId=card["id"],
        summary="补查完成，已生成章节修改建议。请核对新增证据和前后内容，确认后写入研报。",
    )


def accept_revision(store, cid, card_id):
    with store.transaction():
        chat = store.get(cid)
        card = next((c for c in chat["cards"] if c["id"] == card_id), None)
        if (
            not card
            or card["kind"] != "revision"
            or card["data"]["status"] != "pending"
        ):
            raise AppError("该修改建议不在待确认状态")
        report = chat.get("report")
        if not report or report["version"] != card["data"]["baseVersion"]:
            raise AppError("报告已有新版本，请重新补查生成建议", 409)
        for key, version in card["data"].get("dependencyVersions", {}).items():
            if not any(
                c["id"] == key and c["version"] == version for c in chat["cards"]
            ):
                raise AppError("引用底稿已变化，请重新补查", 409)
        if any(not evidence(chat, s) for s in card["sourceIds"]):
            raise AppError("修改建议的来源已失效")
        section = next(
            (s for s in report["sections"] if s["id"] == card["data"]["sectionId"]),
            None,
        )
        if not section:
            raise AppError("章节不存在")
        chat["reports"].append(clone(report))
        section.update(title=card["data"]["sectionTitle"], content=card["data"]["body"])
        report["sourceIds"] = unique([*report["sourceIds"], *card["sourceIds"]])
        report["version"] += 1
        report["at"] = now()
        for source_card in chat["cards"]:
            if source_card["kind"] == "revision" or not any(
                s in card["sourceIds"] for s in source_card["sourceIds"]
            ):
                continue
            source_card["selected"] = True
            report["cardVersions"][source_card["id"]] = source_card["version"]
            if source_card["kind"] in ("chart", "financials", "scenario", "worksheet"):
                report["artifacts"] = [
                    c for c in report["artifacts"] if c["id"] != source_card["id"]
                ] + [clone(source_card)]
        card["data"].update(status="accepted", acceptedVersion=report["version"])
        card["version"] += 1
        chat["revision"] += 1
        return store.put(chat)


class ReportService:
    """HTTP应用调用；装配受限writeReport运行，重试由统一AgentLoop负责。"""

    def __init__(self, sessions, transport, controls, verifier=None):
        self.sessions, self.store, self.transport, self.controls = (
            sessions,
            sessions.store,
            transport,
            controls,
        )
        self.verifier = verifier or NoopVerifier()

    async def run(self, cid, mode, messages, execute, max_tokens, token=None):
        """组稿/改写服务装配受限工具运行；重试由统一Loop执行，不另写模型循环。"""
        run = dict(
            id=uid(),
            mode=mode,
            question="编成研报" if mode == "report" else "修改章节",
            at=now(),
            status="running",
            stage="writing",
            round=0,
            events=[],
            records=[],
            usage=0,
        )
        self.sessions.create_run(cid, run)
        token = CancellationToken(token)
        self.controls[run["id"]] = token
        model = ModelService(
            self.transport,
            self.sessions,
            dict(sessionId=cid, runId=run["id"], purpose=mode),
            token,
        )

        async def handler(args, _):
            try:
                return await execute(args, run["id"], token)
            except Exception as error:
                self.sessions.audit(
                    cid,
                    run["id"],
                    dict(
                        name="writeReport",
                        status="rejected"
                        if getattr(error, "code", None) == "VERIFICATION_REJECTED"
                        else "error",
                        error=dict(
                            code=getattr(error, "code", type(error).__name__),
                            message=str(error),
                        ),
                    ),
                )
                raise

        schema = ASSETS["schemas"]["writeReport"]["function"]
        registry = ToolRegistry(
            [
                {
                    **schema,
                    "terminal": True,
                    "category": "delivery",
                    "preconditions": ["confirmed-materials"],
                    "produces": [
                        "report-version" if mode == "report" else "section-proposal"
                    ],
                    "load": lambda: handler,
                }
            ]
        )
        assembler = ContextAssembler(
            registry, base_messages=messages, force_terminal=True
        )

        async def assemble(scope, signal):
            return dict(
                model=model,
                registry=registry,
                assembler=assembler,
                trace=lambda m: self.sessions.begin_step(cid, run["id"], m),
                observe=lambda call, result, metadata: self.sessions.observe(
                    cid, run["id"], call, result, metadata
                ),
                checkpoint=lambda state: self.sessions.checkpoint(
                    cid, run["id"], state
                ),
                error_feedback=lambda e: dict(
                    error=str(e),
                    code=getattr(e, "code", "ERROR"),
                    instruction="删除无依据数字，复制computed已有display，不心算；重新完整输出writeReport。",
                ),
            )

        try:
            if mode == "report":
                self.sessions.job(cid, dict(runId=run["id"], stage="writing"))
            runtime = AgentRuntimeFactory(assemble).create(
                cid, run["id"], token=token, max_steps=2, max_tool_calls=2
            )
            outcome = await runtime.run(
                dict(task={"goal": run["question"]}),
                phase=mode,
                llm_options=dict(max_tokens=max_tokens),
            )
            if outcome["reason"] != "completed":
                errors = [
                    r["result"]
                    for r in self.sessions.load(cid, run["id"])["records"]
                    if isinstance(r.get("result"), dict) and r["result"].get("error")
                ]
                last = errors[-1] if errors else outcome.get("error") or {}
                raise AppError(
                    last.get("error")
                    or last.get("message")
                    or "报告未通过校验，请重试",
                    409 if last.get("code") == "COMMIT_CONFLICT" else 400,
                    last.get("code", "ERROR"),
                )
            self.sessions.finish(
                cid,
                run["id"],
                dict(
                    reason="completed",
                    steps=outcome["steps"],
                    toolCalls=outcome["toolCalls"],
                ),
            )
            self.sessions.update(
                cid,
                run["id"],
                lambda _, r: r.update(
                    status="completed", stage="completed", finishedAt=now()
                ),
            )
            return outcome["result"]
        except BaseException as error:
            self.sessions.finish(
                cid,
                run["id"],
                dict(
                    reason="cancelled" if token.cancelled else "failed",
                    error=str(error),
                ),
            )
            self.sessions.update(
                cid,
                run["id"],
                lambda _, r, error=error: r.update(
                    status="cancelled" if token.cancelled else "failed",
                    stage="stopped",
                    error=str(error),
                    finishedAt=now(),
                ),
            )
            raise
        finally:
            self.controls.pop(run["id"], None)

    async def compile(self, cid, format="full", token=None):
        """HTTP要求组稿；只读取确认材料，候选审阅通过且版本未变才提交。"""
        initial = self.store.get(cid)
        if format not in ("full", "brief"):
            raise AppError("不支持该报告类型")
        if (initial.get("reportJob") or {}).get("status") == "running" or any(
            r["status"] == "running" for r in initial["runs"]
        ):
            raise AppError("请等待当前研究或组稿结束")
        cards = [
            c for c in initial["cards"] if c.get("selected") and c["kind"] != "gaps"
        ]
        if not cards:
            raise AppError("先勾选需要写进研报的研究卡片、表格或图表")
        if len(cards) > 20:
            raise AppError("请先将选中材料缩减到20项以内")
        before = (initial.get("report") or {}).get("version", 0)
        versions = {c["id"]: c["version"] for c in cards}
        ids = unique(s for c in cards for s in c["sourceIds"])
        computed = report_computations(initial, cards, ids)
        selected = []
        for card in cards:
            data = clone(card["data"])
            if card["kind"] == "worksheet":
                data.pop("facts", None)
                data.pop("alignment", None)
                for row in data["rows"]:
                    for cell in row["cells"].values():
                        cell.pop("candidates", None)
            selected.append(
                dict(
                    kind=card["kind"],
                    title=card["title"],
                    data=data,
                    sourceIds=card["sourceIds"],
                )
            )
        sources = []
        for sid in ids:
            source = evidence(initial, sid)
            sources.append(
                dict(
                    id=sid,
                    name=source.get("name") if source else None,
                    date=source.get("date") if source else None,
                    data=source.get("data")
                    if source and source.get("data", {}).get("frequency")
                    else None,
                )
            )
        payload = dict(
            computed=computed,
            reportFormat="财报点评：300至800字，围绕关键变化和风险边界"
            if format == "brief"
            else "公司研究：1800至3000字，证据不足则缩短",
            selected=selected,
            researchQuestion=[
                m["text"] for m in initial["messages"] if m["role"] == "user"
            ][-3:],
            gaps=[c["data"]["items"] for c in initial["cards"] if c["kind"] == "gaps"],
            sources=sources,
        )
        messages = report_messages(format, payload)

        async def execute(data, rid, signal):
            signal.check()
            if (
                not data.get("title")
                or not isinstance(data.get("sections"), list)
                or not data["sections"]
            ):
                raise AppError("研报结构不完整")
            if not any(c["kind"] == "scenario" for c in cards):
                data["sections"] = [
                    s
                    for s in data["sections"]
                    if not re.search("情景|假设沙盘", s.get("title", ""))
                ]
            if len(data["sections"]) > (4 if format == "brief" else 9):
                raise AppError("报告章节过多，请合并空泛或重复章节")
            self.sessions.job(cid, dict(stage="reviewing"))
            review = review_draft(initial, data, ids, computed)
            verdict = await self.verifier.verify(
                dict(
                    toolName="writeReport",
                    data=clone(data),
                    sources=self.sessions.sources(cid, {"sourceIds": ids}),
                ),
                dict(sessionId=cid, runId=rid, task={"goal": "编成研报"}),
            )
            signal.check()
            if verdict.get("accepted") is not True:
                raise VerificationRejected(verdict.get("reason") or "验证未通过")
            report = dict(
                id=uid(),
                title=data["title"],
                format=format,
                review=review,
                at=now(),
                version=before + 1,
                stale=False,
                sourceIds=ids,
                cardVersions=versions,
                sections=[
                    dict(id=uid(), title=s["title"], content=s["content"])
                    for s in data["sections"]
                ],
                artifacts=clone(
                    [
                        c
                        for c in cards
                        if c["kind"] in ("worksheet", "chart", "scenario", "financials")
                    ]
                ),
            )
            self.sessions.commit_report(
                cid,
                rid,
                report,
                dict(version=before, versions=versions, ids=[c["id"] for c in cards]),
            )
            return dict(done=True, reportId=report["id"], sourceIds=ids)

        self.sessions.job(
            cid, dict(status="running", stage="preparing", at=now(), error=None)
        )
        try:
            await self.run(
                cid,
                "report",
                messages,
                execute,
                3000 if format == "brief" else 7500,
                token,
            )
            self.sessions.job(
                cid, dict(status="completed", stage="completed", finishedAt=now())
            )
            return self.store.get(cid)
        except BaseException as error:
            job = self.store.get(cid).get("reportJob", {})
            self.sessions.job(
                cid,
                dict(
                    status="cancelled"
                    if token and token.cancelled or job.get("status") == "cancelled"
                    else "failed",
                    stage="stopped",
                    error=str(error),
                    finishedAt=now(),
                ),
            )
            raise

    async def revise(self, cid, section_id, instruction):
        """HTTP请求单章建议；返回baseVersion和内容，用户确认前不覆盖报告。"""
        chat = self.store.get(cid)
        report = chat.get("report")
        section = (
            next((s for s in report["sections"] if s["id"] == section_id), None)
            if report
            else None
        )
        if not section:
            raise AppError("章节不存在")
        if not str(instruction or "").strip():
            raise AppError("请填写修改要求")
        computed = report_computations(
            chat, [c for c in chat["cards"] if c.get("selected")], report["sourceIds"]
        )
        from ..context.assembler import extraction_messages

        messages = extraction_messages(
            "section",
            dict(
                section=section,
                computed=computed,
                instruction=str(instruction)[:3000],
                confirmed=[
                    dict(title=c["title"], data=c["data"], sourceIds=c["sourceIds"])
                    for c in chat["cards"]
                    if c.get("selected")
                ],
            ),
        )

        async def execute(data, rid, signal):
            content = (data.get("sections") or [{}])[0].get("content")
            if not isinstance(content, str):
                raise AppError("修改建议为空")
            if any(s not in report["sourceIds"] for s in refs(content)):
                raise AppError("修改引入了未确认来源")
            review_draft(
                chat,
                dict(sections=[dict(title=section["title"], content=content)]),
                report["sourceIds"],
                computed,
            )
            signal.check()
            if (self.store.get(cid).get("report") or {}).get("version") != report[
                "version"
            ]:
                raise AppError("研报版本已变化，请重新修改", 409, "COMMIT_CONFLICT")
            return dict(
                done=True,
                proposal=dict(
                    sectionId=section_id, content=content, baseVersion=report["version"]
                ),
                sourceIds=report["sourceIds"],
            )

        return (await self.run(cid, "section-edit", messages, execute, 2300))[
            "proposal"
        ]
