"""执行轨迹的唯一写入点；不参与提示词、取数或投资判断。"""

import json
import time
from ..common import AppError, clone, dumps, error_data, now, uid


class SessionStore:
    """Loop、模型端口、提交流水线共同调用；兼容 Node 版表结构。"""

    def __init__(self, store):
        self.store = store
        self.db = store.db
        self.db.executescript("""CREATE TABLE IF NOT EXISTS agent_trace_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,run_id TEXT NOT NULL,span_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_trace_events_run ON agent_trace_events(session_id,run_id,seq);
CREATE TABLE IF NOT EXISTS agent_trace_steps(span_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_model_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agent_model_calls_run ON agent_model_calls(session_id,run_id);""")

    def load(self, cid, rid):
        """运行装配/检查接口读取任务副本；不恢复或启动执行。"""
        run = next((r for r in self.store.get(cid)["runs"] if r["id"] == rid), None)
        if not run:
            raise AppError("研究任务不存在", 404)
        return run

    def update(self, cid, rid, change):
        """应用更新任务状态与遥测；不在回调中等待外部IO。"""
        chat = self.store.get(cid)
        run = next((r for r in chat["runs"] if r["id"] == rid), None)
        if not run:
            raise AppError("研究任务不存在")
        change(chat, run)
        self.store.put(chat)

    def create_run(self, cid, run, user=None, assistant=None):
        """应用创建一次执行；可关联真实用户/助手消息，不启动模型。"""
        chat = self.store.get(cid)
        if any(r["status"] == "running" for r in chat["runs"]):
            raise AppError("请先等待当前任务结束或停止")
        if user and assistant:
            chat["messages"].extend([user, assistant])
            if len(chat["messages"]) == 2:
                chat["title"] = " ".join(user["text"].split())[:30]
        chat["runs"].append(run)
        self.store.put(chat)

    def event(self, cid, rid, label, detail=""):
        """工具或应用追加人可读进度；不把进度声明当成已验证结果。"""
        self.update(
            cid,
            rid,
            lambda _, r: r["events"].append(
                dict(at=now(), label=label, detail=str(detail)[:300])
            ),
        )

    def append_event(self, cid, rid, span_id, kind, payload):
        """步骤记录器追加结构化事件；不覆盖原始历史。"""
        self.db.execute(
            "INSERT INTO agent_trace_events(session_id,run_id,span_id,kind,body) VALUES(?,?,?,?,?)",
            (cid, rid, span_id, kind, dumps({"at": now(), **payload})),
        )

    def sources(self, cid, value):
        """轨迹记录器解析显式来源指针；不从文字推测证据。"""
        from ..tools.documents import evidence

        ids, cards = set(), set()

        def walk(v):
            if isinstance(v, list):
                for x in v:
                    walk(x)
            elif isinstance(v, dict):
                if isinstance(v.get("sourceId"), str):
                    ids.add(v["sourceId"])
                ids.update(v.get("sourceIds") or [])
                if v.get("cardId"):
                    cards.add(v["cardId"])
                cards.update(v.get("cardIds") or [])
                for x in v.values():
                    walk(x)

        walk(value)
        chat = self.store.get(cid)
        for card in chat["cards"]:
            if card["id"] in cards:
                ids.update(card["sourceIds"])
        result = []
        for sid in sorted(ids):
            source = evidence(chat, sid)
            if not source:
                result.append(dict(id=sid, kind="unknown", label=sid, resolved=False))
            elif source.get("documentId"):
                result.append(
                    dict(
                        id=sid,
                        kind="document",
                        label=source["name"],
                        page=source["page"],
                        uri=f"/api/chats/{cid}/documents/{source['documentId']}/file",
                    )
                )
            else:
                data = source.get("data") or {}
                result.append(
                    dict(
                        id=sid,
                        kind="user"
                        if data.get("input") and data.get("basePeriod")
                        else "external",
                        label=source["name"],
                        uri=source.get("sourceUrl"),
                        observedAt=source.get("date"),
                    )
                )
        return result

    def begin_step(self, cid, rid, metadata):
        """Loop开始一轮时创建span；不决定下一步行动。"""
        self.load(cid, rid)
        return StepSpan(self, cid, rid, metadata)

    def observe(self, cid, rid, call, result, metadata):
        """Loop保存实际工具观察，保留兼容字段；不生成业务结论。"""
        self.update(
            cid,
            rid,
            lambda _, r: r["records"].append(
                dict(
                    callId=call["id"],
                    actor=call.get("actor", "model"),
                    name=call["function"]["name"],
                    args=call["function"]["arguments"],
                    result=clone(result),
                    at=now(),
                    **metadata,
                )
            ),
        )

    def checkpoint(self, cid, rid, state, seen=(), calculations=()):
        """Loop保存最新可恢复快照；完整历史仍追加保存在trace表。"""
        self.update(
            cid,
            rid,
            lambda _, r: r.update(
                checkpoint={
                    **clone(state),
                    "seen": list(seen),
                    "calculations": clone(calculations),
                    "at": now(),
                },
                round=state.get("step", 0),
            ),
        )

    def finish(self, cid, rid, outcome):
        """应用记录退出原因；取消网络请求由取消端口负责。"""
        self.update(
            cid,
            rid,
            lambda _, r: r.update(
                termination={
                    **outcome,
                    "reason": "cancelled"
                    if r["status"] == "cancelled"
                    else outcome["reason"],
                    "at": now(),
                }
            ),
        )

    def job(self, cid, changes):
        """组稿应用更新页面进度；不能通过此方法提交报告内容。"""
        chat = self.store.get(cid)
        chat["reportJob"] = {**chat.get("reportJob", {}), **changes}
        self.store.put(chat)

    def audit(self, cid, rid, payload):
        """执行流水线记录接受/拒绝；不代替验证器检查内容。"""
        row = self.db.execute(
            "SELECT span_id FROM agent_trace_events WHERE session_id=? AND run_id=? AND kind='started' ORDER BY seq DESC LIMIT 1",
            (cid, rid),
        ).fetchone()
        self.append_event(
            cid,
            rid,
            row[0] if row else "tool:" + str(payload.get("callId")),
            "tool_verification",
            payload,
        )

    def start_model_call(self, call):
        """模型端口在请求前记录归属；不保存Key或输入消息全文。"""
        self.load(call["sessionId"], call["runId"])
        self.db.execute(
            "INSERT INTO agent_model_calls VALUES(?,?,?,?)",
            (call["id"], call["sessionId"], call["runId"], dumps(call)),
        )

    def finish_model_call(self, call):
        """模型端口完成记账；用事务保证同一调用的Token只累加一次。"""
        with self.store.transaction():
            row = self.db.execute(
                "SELECT body FROM agent_model_calls WHERE id=?", (call["id"],)
            ).fetchone()
            if not row:
                raise AppError("模型调用不存在")
            if json.loads(row[0])["status"] == "running":
                self.db.execute(
                    "UPDATE agent_model_calls SET body=? WHERE id=?",
                    (dumps(call), call["id"]),
                )
                self.update(
                    call["sessionId"],
                    call["runId"],
                    lambda _, r: r.update(
                        usage=r.get("usage", 0) + call.get("usage", 0)
                    ),
                )

    def read_trace(self, cid, rid):
        """只读检查接口返回步骤与模型账本；不会重放执行。"""
        self.load(cid, rid)
        return dict(
            steps=[
                json.loads(r[0])
                for r in self.db.execute(
                    "SELECT body FROM agent_trace_steps WHERE session_id=? AND run_id=? ORDER BY rowid",
                    (cid, rid),
                )
            ],
            modelCalls=[
                json.loads(r[0])
                for r in self.db.execute(
                    "SELECT body FROM agent_model_calls WHERE session_id=? AND run_id=? ORDER BY rowid",
                    (cid, rid),
                )
            ],
            events=[
                dict(r) | {"body": json.loads(r["body"])}
                for r in self.db.execute(
                    "SELECT * FROM agent_trace_events WHERE session_id=? AND run_id=? ORDER BY seq",
                    (cid, rid),
                )
            ],
        )

    def snapshot(self, cid):
        """执行端口读取独立会话副本；不返回可直接改写的内部对象。"""
        return self.store.get(cid)

    def commit_tool(self, cid, rid, base, candidate, audit):
        """验证通过后原子提交；只比较有变化的字段，避免覆盖并发用户编辑。"""
        fields = (
            "cards",
            "messages",
            "researchSources",
            "documentAnalysisCache",
            "researchPlan",
        )
        changes = [key for key in fields if candidate.get(key) != base.get(key)]
        old_run = next(r for r in base["runs"] if r["id"] == rid)
        new_run = next(r for r in candidate["runs"] if r["id"] == rid)
        with self.store.transaction():
            fresh = self.store.get(cid)
            run = next(r for r in fresh["runs"] if r["id"] == rid)
            if run["status"] != "running":
                raise AppError("任务已结束，工具结果未提交", code="RUN_NOT_ACTIVE")
            if audit["name"] == "proposeReportRevision" and (
                fresh.get("report") or {}
            ).get("version") != run.get("baseReportVersion"):
                raise AppError("研报版本已变化，工具结果未提交", code="COMMIT_CONFLICT")
            for key in changes:
                if fresh.get(key) != base.get(key):
                    raise AppError(
                        "研究内容已变化，工具结果未提交：" + key, code="COMMIT_CONFLICT"
                    )
            if new_run.get("plan") != old_run.get("plan"):
                if run.get("plan") != old_run.get("plan"):
                    raise AppError(
                        "研究计划已变化，工具结果未提交", code="COMMIT_CONFLICT"
                    )
                run["plan"] = clone(new_run.get("plan"))
            for key in changes:
                fresh[key] = clone(candidate[key])
            if changes or new_run.get("plan") != old_run.get("plan"):
                fresh["revision"] += 1
                self.store.put(fresh)
            self.audit(cid, rid, audit)

    def commit_report(self, cid, rid, report, expected):
        """报告版本提交点；选项或底稿版本变化时拒绝整份提交。"""
        with self.store.transaction():
            chat = self.store.get(cid)
            run = next(r for r in chat["runs"] if r["id"] == rid)
            cards = [
                c for c in chat["cards"] if c.get("selected") and c["kind"] != "gaps"
            ]
            if run["status"] != "running":
                raise AppError("组稿任务已结束")
            if (
                (chat.get("report") or {}).get("version", 0) != expected["version"]
                or [c["id"] for c in cards] != expected["ids"]
                or any(c["version"] != expected["versions"].get(c["id"]) for c in cards)
            ):
                raise AppError("所选内容已变化，请重新编成研报", 409, "COMMIT_CONFLICT")
            if chat.get("report"):
                chat["reports"].append(clone(chat["report"]))
            chat["report"] = clone(report)
            chat["revision"] += 1
            self.store.put(chat)
            self.audit(
                cid,
                rid,
                dict(
                    name="writeReport", status="accepted", sourceIds=report["sourceIds"]
                ),
            )

    def recover_interrupted(self):
        # 只有服务真正启动才执行；导入模块或运行测试不能中断真实任务。
        for row in self.db.execute("SELECT id,body FROM agent_model_calls").fetchall():
            call = json.loads(row[1])
            if call["status"] == "running":
                call.update(status="interrupted", usageKnown=False, finishedAt=now())
                self.db.execute(
                    "UPDATE agent_model_calls SET body=? WHERE id=?",
                    (dumps(call), row[0]),
                )
        for chat in self.store.list():
            changed = False
            if chat.get("reportJob", {}).get("status") == "running":
                chat["reportJob"].update(
                    status="interrupted",
                    stage="stopped",
                    error="服务已重启，请重新组稿",
                )
                changed = True
            for run in chat["runs"]:
                if run.get("status") == "running":
                    run.update(
                        status="interrupted",
                        stage="stopped",
                        error="服务已重启，可以重新发送问题",
                        termination=dict(reason="interrupted", at=now()),
                    )
                    changed = True
            if changed:
                self.store.put(chat)


class StepSpan:
    """一轮执行的记录器；保存可观察决策，不索取模型隐藏思维链。"""

    def __init__(self, store, cid, rid, metadata):
        self.store, self.cid, self.rid = store, cid, rid
        self.start = time.perf_counter()
        self.record = dict(
            spanId=uid(),
            runId=rid,
            startedAt=now(),
            rawDecision=None,
            calls=[],
            **metadata,
        )
        self.closed = False
        store.append_event(cid, rid, self.record["spanId"], "started", metadata)

    def decision(self, response):
        self.record.update(
            rawDecision=clone(response),
            decisionDurationMs=(time.perf_counter() - self.start) * 1000,
        )
        self.store.append_event(
            self.cid,
            self.rid,
            self.record["spanId"],
            "decision",
            {k: self.record[k] for k in ("rawDecision", "decisionDurationMs")},
        )

    def observation(self, call, args, result, timing, error=None):
        sources = self.store.sources(self.cid, result)
        status = (
            "rejected"
            if isinstance(result, dict) and result.get("status") == "rejected"
            else "error"
            if error or isinstance(result, dict) and result.get("error")
            else "success"
        )
        entry = dict(
            callId=call["id"],
            name=call["function"]["name"],
            args=clone(args),
            rawArguments=call["function"]["arguments"],
            source=sources,
            observation=dict(
                callId=call["id"],
                toolName=call["function"]["name"],
                status=status,
                data=clone(result),
                sources=sources,
                timing=timing,
                error=error_data(error) if error else None,
            ),
        )
        self.record["calls"].append(entry)
        self.store.append_event(
            self.cid, self.rid, self.record["spanId"], "observation", entry
        )

    def end(self, status="continued", error=None):
        if self.closed:
            return
        self.record.update(
            status=status,
            error=error_data(error) if error else None,
            durationMs=(time.perf_counter() - self.start) * 1000,
        )
        self.store.db.execute(
            "INSERT INTO agent_trace_steps VALUES(?,?,?,?)",
            (self.record["spanId"], self.cid, self.rid, dumps(self.record)),
        )
        self.store.append_event(
            self.cid,
            self.rid,
            self.record["spanId"],
            "ended",
            {k: self.record[k] for k in ("status", "error", "durationMs")},
        )
        self.closed = True
