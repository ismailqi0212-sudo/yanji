"""应用装配：把模型、工具、记忆、轨迹连接起来，再交给通用Loop。"""

import asyncio
from ..common import AppError, clone, now, uid
from ..context.assembler import ContextAssembler, research_policy, repair_messages
from ..llm.model import ModelService
from ..tools.handlers import create_tools
from ..research.artifacts import financial_comparisons
from .router import route_task, get_skill
from .runtime_factory import AgentRuntimeFactory
from .cancellation import CancellationToken


class ResearchApplication:
    """HTTP入口调用start/stop；拥有任务生命周期，不实现金融工具。"""

    def __init__(self, sessions, transport, finance, controls=None):
        self.sessions, self.store, self.transport, self.finance = (
            sessions,
            sessions.store,
            transport,
            finance,
        )
        self.controls = controls if controls is not None else {}
        self.tasks = {}

    def start(self, cid, question, options=None):
        """HTTP发起研究；创建消息/run和后台任务，不同步等待整份研究结束。"""
        options = options or {}
        chat = self.store.get(cid)
        text = str(question or "").strip()[:8000]
        if not text:
            raise AppError("请输入研究问题")
        if options.get("mode") == "revision" and not any(
            s["id"] == options.get("sectionId")
            for s in (chat.get("report") or {}).get("sections", [])
        ):
            raise AppError("章节不存在")
        route = route_task(chat, text, options)
        user = dict(id=uid(), role="user", text=text, at=now(), cardIds=[])
        assistant = dict(id=uid(), role="assistant", text="", at=now(), cardIds=[])
        run = dict(
            id=uid(),
            messageId=assistant["id"],
            question=text,
            mode=options.get("mode", "research"),
            sourceMode=route["sourceMode"],
            route=route,
            sectionId=options.get("sectionId"),
            baseReportVersion=(chat.get("report") or {}).get("version"),
            at=now(),
            status="running",
            stage="planning",
            round=0,
            events=[],
            records=[],
            usage=0,
        )
        self.sessions.create_run(cid, run, user, assistant)
        token = CancellationToken()
        self.controls[run["id"]] = token
        task = asyncio.create_task(self.execute(cid, run, token))
        self.tasks[run["id"]] = task
        task.add_done_callback(lambda _: self.tasks.pop(run["id"], None))
        return clone(run)

    def stop(self, cid, rid):
        # 先检查会话归属，不能用另一对话的runId停止任务。
        """HTTP停止当前会话的run；先检查归属，再传递取消信号并保存状态。"""
        self.sessions.load(cid, rid)
        if rid in self.controls:
            self.controls[rid].cancel()

        def change(chat, run):
            if run["status"] == "running":
                run.update(
                    status="cancelled",
                    stage="stopped",
                    error="已停止，已取得的数据保留",
                    termination=dict(reason="cancelled", at=now()),
                )
                if (chat.get("reportJob") or {}).get("runId") == rid:
                    chat["reportJob"].update(
                        status="cancelled", stage="stopped", error="任务已停止"
                    )

        self.sessions.update(cid, rid, change)

    async def execute(self, cid, run, token):
        """后台任务入口；装配模型、工具和记忆，再把控制权交给唯一AgentLoop。"""
        loop = asyncio.get_running_loop()
        timer = loop.call_later(run["route"]["timeoutMs"] / 1000, token.cancel)
        try:
            initial = self.store.get(cid)
            mode = run["sourceMode"]
            from ..context.assembler import SessionMemory

            recall = await SessionMemory(initial, run).retrieve({"sessionId": cid})
            confirmed = recall["projectMemory"]["confirmed"]
            seen = set(s for c in confirmed for s in c.get("sourceIds", []))
            calculations = financial_comparisons(
                [
                    c
                    for c in initial["cards"]
                    if c.get("selected") and c["id"] in {c["id"] for c in confirmed}
                ]
            )
            for old_run in initial["runs"]:
                for record in old_run.get("records", []):
                    data = record.get("result")
                    if (
                        record.get("name") == "calculate"
                        and isinstance(data, dict)
                        and data.get("sourceIds")
                        and all(s in seen for s in data["sourceIds"])
                    ):
                        calculations.append(clone(data))
            model = ModelService(
                self.transport,
                self.sessions,
                dict(sessionId=cid, runId=run["id"], purpose="agent-decision"),
                token,
            )
            context = dict(
                cid=cid,
                run=run,
                sessions=self.sessions,
                token=token,
                seen=seen,
                calculations=calculations,
                financial_cache=set(),
                model=model,
                finance=self.finance,
            )
            tools = create_tools(context)
            assembler = ContextAssembler(
                tools,
                system_policy=research_policy(
                    run, get_skill(run["route"].get("skillId"))
                ),
                short_term=SessionMemory(initial, run),
            )

            def on_event(kind, data):
                if kind == "thinking":
                    self.sessions.event(
                        cid,
                        run["id"],
                        "理解研究任务" if data["step"] == 1 else "读取观察并继续研究",
                        f"第{data['step']}轮",
                    )
                    self.sessions.update(
                        cid,
                        run["id"],
                        lambda _, r: r.update(
                            stage="planning" if data["step"] == 1 else "researching"
                        ),
                    )
                elif kind == "acting":
                    self.sessions.update(
                        cid,
                        run["id"],
                        lambda _, r: r.update(
                            stage="checking" if data.get("terminal") else "researching"
                        ),
                    )
                elif kind == "tool_error":
                    self.sessions.event(
                        cid, run["id"], "工具反馈，继续补查", data["error"]
                    )

            async def assemble(scope, signal):
                return dict(
                    model=model,
                    registry=tools,
                    assembler=assembler,
                    trace=lambda m: self.sessions.begin_step(cid, run["id"], m),
                    observe=lambda call, result, metadata: self.sessions.observe(
                        cid, run["id"], call, result, metadata
                    ),
                    checkpoint=lambda state: self.sessions.checkpoint(
                        cid, run["id"], state, seen, calculations
                    ),
                    on_event=on_event,
                    on_text=lambda text: self.sessions.update(
                        cid, run["id"], lambda _, r: r.update(liveText=text)
                    ),
                )

            initial_actions = []
            if initial["documents"] and mode != "external":
                bootstrap = next(
                    (
                        e
                        for e in tools.list()
                        if run["route"].get("skillId")
                        and e.get("bootstrap") == run["route"]["skillId"]
                    ),
                    None,
                ) or next(
                    (e for e in tools.list() if e.get("bootstrap") == "documents"), None
                )
                if not bootstrap:
                    raise AppError("缺少上传材料前置读取能力")
                initial_actions = [
                    dict(name=bootstrap["name"], args={"focus": run["question"]})
                ]

            async def repair(failure, state):
                if run["mode"] == "revision" or failure["reason"] == "cancelled":
                    return None
                records = self.sessions.load(cid, run["id"])["records"]
                failed = [
                    r
                    for r in records
                    if r["name"] == "deliverResearch"
                    and isinstance(r.get("result"), dict)
                    and r["result"].get("error")
                ]
                if not failed:
                    return None

                # 修复只开放交付工具；不允许借修稿继续无限取数。
                class TerminalRegistry:
                    def list(self):
                        return [e for e in tools.list() if e.get("terminal")]

                    async def invoke(self, name, args, metadata=None):
                        if name not in {e["name"] for e in self.list()}:
                            raise AppError("修复阶段禁止该工具")
                        return await tools.invoke(name, args, metadata)

                restricted = TerminalRegistry()
                from json_repair import repair_json

                draft = repair_json(failed[-1]["args"], return_objects=True)
                fresh = self.store.get(cid)
                from ..tools.documents import evidence

                payload = dict(
                    draft=draft,
                    errors=[r["result"]["error"] for r in failed],
                    computed=calculations,
                    sources=[
                        evidence(fresh, s) for s in sorted(seen) if evidence(fresh, s)
                    ],
                )
                messages = repair_messages(payload)
                return dict(
                    registry=restricted,
                    assembler=ContextAssembler(
                        restricted, base_messages=messages, force_terminal=True
                    ),
                    max_steps=2,
                    max_tool_calls=2,
                    llm_options={"max_tokens": 5200},
                )

            runtime = AgentRuntimeFactory(assemble).create(
                cid,
                run["id"],
                source_mode=mode,
                token=token,
                max_steps=run["route"]["maxSteps"],
                max_tool_calls=run["route"]["maxToolCalls"],
            )
            outcome = await runtime.run(
                dict(task={"goal": run["question"], "sourceMode": mode}),
                initial_actions=initial_actions,
                recovery=dict(prepare=repair, max_steps=2, max_tool_calls=2),
            )
            self.sessions.finish(
                cid,
                run["id"],
                {
                    k: outcome[k]
                    for k in (
                        "reason",
                        "steps",
                        "toolCalls",
                        "phase",
                        "recoveryAttempted",
                    )
                },
            )
            if outcome["reason"] != "completed":
                error = outcome.get("error") or {}
                self.sessions.update(
                    cid,
                    run["id"],
                    lambda _, r: r.update(
                        status="cancelled" if token.cancelled else "failed",
                        stage="stopped",
                        error=error.get("message", "研究未完成"),
                        finishedAt=now(),
                        liveText="",
                    ),
                )
                return

            def complete(chat, current):
                if current["status"] != "running":
                    return
                current.update(
                    status="completed",
                    stage="awaiting_confirmation"
                    if run["mode"] == "revision"
                    else "completed",
                    finishedAt=now(),
                    liveText="",
                    recoveredAfterValidation=outcome["recovered"],
                )
                next(m for m in chat["messages"] if m["id"] == run["messageId"])[
                    "text"
                ] = outcome["result"].get("summary", "研究完成。")
                current["events"].append(
                    dict(
                        at=now(),
                        label="修改建议已生成，等待确认"
                        if run["mode"] == "revision"
                        else "研究完成",
                        detail=f"{outcome['steps']}轮 · {outcome['toolCalls']}次工具调用",
                    )
                )

            self.sessions.update(cid, run["id"], complete)
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
                lambda _, r: r.update(
                    status="cancelled" if token.cancelled else "failed",
                    stage="stopped",
                    error=str(error),
                    finishedAt=now(),
                    liveText="",
                ),
            )
        finally:
            timer.cancel()
            self.controls.pop(run["id"], None)

    async def shutdown(self):
        """服务关闭时停止后台IO并等待清理；不触碰已完成历史。"""
        for token in list(self.controls.values()):
            token.cancel()
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
