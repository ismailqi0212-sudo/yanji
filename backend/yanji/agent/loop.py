"""唯一的显式 Agent 控制循环；没有证券代码、PDF或研报业务实现。"""

import json
import time
from json_repair import repair_json
from ..common import AppError, clone, dumps, error_data, now, uid
from .cancellation import Cancelled, cancellable
from ..ports import ModelPort, RegistryPort, ContextPort


def parse_decision(response):
    """把模型可观察输出解析成行动或完成；不执行工具、不推测隐藏思维。"""
    if not isinstance(response, dict):
        return dict(kind="invalid", actions=[])
    if isinstance(response.get("tool_calls"), list) and response["tool_calls"]:
        actions = []
        for call in response["tool_calls"]:
            try:
                args = repair_json(
                    call.get("function", {}).get("arguments") or "{}",
                    return_objects=True,
                )
                if not isinstance(args, dict):
                    raise ValueError("工具参数必须是对象")
                actions.append(dict(call=call, args=args))
            except (TypeError, ValueError) as error:
                actions.append(dict(call=call, error=str(error)))
        return dict(kind="act", actions=actions)
    value = response.get("decision")
    if value is None:
        try:
            value = json.loads(response.get("content") or "")
        except (TypeError, ValueError):
            pass
    if (
        isinstance(value, dict)
        and value.get("type") == "finish"
        and isinstance(value.get("summary"), str)
        and value["summary"].strip()
    ):
        return dict(
            kind="finish",
            summary=value["summary"],
            output=value.get("output"),
            actions=[],
        )
    return dict(kind="invalid", actions=[])


class AgentLoop:
    """应用注入模型、Registry、Assembler、记录器；本类只拥有本次运行状态。"""

    def __init__(
        self,
        model: ModelPort,
        registry: RegistryPort,
        assembler: ContextPort,
        *,
        trace=None,
        observe=None,
        checkpoint=None,
        on_event=None,
        on_text=None,
        error_feedback=None,
    ):
        self.model, self.registry, self.assembler = model, registry, assembler
        self.trace, self.observe, self.checkpoint = trace, observe, checkpoint
        self.on_event = on_event or (lambda *_: None)
        self.on_text = on_text
        self.error_feedback = error_feedback or (
            lambda e: dict(
                error=str(e),
                code=getattr(e, "code", type(e).__name__),
                **(
                    {"status": "rejected"}
                    if getattr(e, "code", None) == "VERIFICATION_REJECTED"
                    else {}
                ),
            )
        )

    async def run(
        self,
        state=None,
        *,
        token=None,
        max_steps=9,
        max_tool_calls=32,
        initial_actions=(),
        require_terminal=True,
        phase="research",
        recovery=None,
        llm_options=None,
    ):
        # state是本次运行的工作台账，不是数据库里的可变对象。
        # 每轮固定经历：构造输入→问模型→解析→行动→写回观察。
        """应用Runtime调用本方法执行一次任务；只协调端口，不读取业务数据库或实现金融工具。"""
        state = clone(state or {})
        state.setdefault("trajectory", [])
        registry, assembler = self.registry, self.assembler
        steps = calls = phase_steps = phase_calls = host_index = 0
        recovery_used = recovered = False
        options = dict(llm_options or {})
        step_limit, call_limit = max_steps, max_tool_calls

        def outcome(reason, result=None, error=None):
            return dict(
                runId=state.get("runId"),
                parentRunId=state.get("parentRunId"),
                reason=reason,
                steps=steps,
                toolCalls=calls,
                phase=phase,
                recovered=recovered and reason == "completed",
                recoveryAttempted=recovery_used,
                result=result,
                error=error_data(error) if error else None,
            )

        async def recover(failure):
            nonlocal \
                registry, \
                assembler, \
                phase_steps, \
                phase_calls, \
                phase, \
                step_limit, \
                call_limit, \
                options, \
                recovery_used, \
                recovered
            if not recovery or recovery_used or token and token.cancelled:
                return False
            recovery_used = True
            config = await recovery["prepare"](failure, clone(state))
            if not config:
                return False
            if (
                not 1 <= config["max_steps"] <= recovery["max_steps"]
                or not 1 <= config["max_tool_calls"] <= recovery["max_tool_calls"]
            ):
                raise AppError("恢复配置超出预先声明预算")
            allowed = {e["name"] for e in registry.list()}
            if not config["registry"].list() or any(
                not e.get("terminal") or e["name"] not in allowed
                for e in config["registry"].list()
            ):
                raise AppError("恢复阶段只能使用原范围内的交付工具")
            registry, assembler = config["registry"], config["assembler"]
            step_limit, call_limit = config["max_steps"], config["max_tool_calls"]
            options = config.get("llm_options", {})
            phase = "repair"
            phase_steps = phase_calls = 0
            state["trajectory"] = []
            recovered = True
            return True

        try:
            if any(type(n) is not int or n < 0 for n in (max_steps, max_tool_calls)):
                raise AppError("无效运行预算")
            # 前置阅读、普通研究和有限修复共用这一个 while，不递归调用另一个Agent。
            while True:
                if token:
                    token.check()
                host = host_index < len(initial_actions)
                if not host and phase_steps >= step_limit:
                    failure = outcome(
                        "budget_exhausted",
                        error=AppError(
                            "研究达到本轮预算，已保存数据和过程。请缩小问题继续研究。",
                            code="BUDGET_EXHAUSTED",
                        ),
                    )
                    if await recover(failure):
                        continue
                    return failure
                step = 0 if host else steps + 1
                span = (
                    self.trace(
                        dict(
                            step=step,
                            phase="preflight" if host else phase,
                            actor="host" if host else "model",
                        )
                    )
                    if self.trace
                    else None
                )
                round_status = "continued"
                round_error = None
                completed = None
                try:
                    entries = registry.list()
                    terminal = next((e for e in entries if e.get("terminal")), None)
                    state.update(
                        availableTools=entries,
                        phase=phase,
                        limits=dict(maxSteps=step_limit, maxToolCalls=call_limit),
                        progress=dict(step=step, toolCalls=phase_calls),
                    )
                    # ① 上下文组装独立出去，Loop不关心提示词怎么写。
                    assembled = await assembler.build(state)
                    if host:
                        requested = initial_actions[host_index]
                        host_index += 1
                        response = dict(
                            actor="host",
                            tool_calls=[
                                dict(
                                    id=requested.get("id") or "host-source-ingestion",
                                    actor="host",
                                    type="function",
                                    function=dict(
                                        name=requested["name"],
                                        arguments=dumps(requested.get("args", {})),
                                    ),
                                )
                            ],
                        )
                    else:
                        steps += 1
                        phase_steps += 1
                        self.on_event("thinking", dict(step=step, phase=phase))
                        # ② 请求一次决策；响应只是行动建议，还没有执行工具。
                        response = await cancellable(
                            self.model.complete(
                                assembled["messages"],
                                tools=assembled["tools"],
                                force=assembled["force"],
                                on_text=self.on_text,
                                **options,
                            ),
                            token,
                        )
                    if span:
                        span.decision(response)
                    if token:
                        token.check()
                    # ③ 解析动作；结构化finish仍需通过终结工具的业务校验。
                    decision = parse_decision(response)
                    if decision["kind"] == "finish":
                        if not require_terminal:
                            completed = dict(done=True, summary=decision["summary"])
                        elif terminal and isinstance(decision.get("output"), dict):
                            call = dict(
                                id=f"declared-finish-{step}",
                                actor="model_finish",
                                type="function",
                                function=dict(
                                    name=terminal["name"],
                                    arguments=dumps(decision["output"]),
                                ),
                            )
                            response = {**response, "tool_calls": [call]}
                            decision = dict(
                                kind="act",
                                actions=[dict(call=call, args=decision["output"])],
                            )
                    if not host:
                        state["trajectory"].append(
                            dict(
                                type="decision",
                                response=response,
                                completed=bool(completed),
                            )
                        )
                    host_failed = False
                    # ④ 通过Registry执行动作；不直接导入任何财务/PDF实现。
                    for action in decision.get("actions", []):
                        if token:
                            token.check()
                        call = action["call"]
                        call.setdefault("id", uid())
                        args = action.get("args")
                        start = time.perf_counter()
                        started = now()
                        error = None
                        try:
                            if action.get("error"):
                                raise AppError(
                                    action["error"], code="INVALID_ARGUMENTS"
                                )
                            descriptor = next(
                                (
                                    e
                                    for e in entries
                                    if e["name"] == call["function"]["name"]
                                ),
                                None,
                            )
                            if not descriptor:
                                raise AppError("未知或当前模式不可用的工具")
                            if completed:
                                result = dict(skipped=True, reason="本轮已交付")
                            elif phase_calls >= call_limit:
                                raise AppError(
                                    "工具预算已用完，请基于现有证据交付并保留缺口",
                                    code="BUDGET_EXHAUSTED",
                                )
                            else:
                                phase_calls += 1
                                calls += 1
                                self.on_event(
                                    "acting",
                                    dict(
                                        name=descriptor["name"],
                                        terminal=bool(descriptor.get("terminal")),
                                        phase=phase,
                                    ),
                                )
                                result = await cancellable(
                                    registry.invoke(
                                        descriptor["name"],
                                        args,
                                        dict(callId=call["id"], token=token),
                                    ),
                                    token,
                                )
                                if (
                                    isinstance(result, dict)
                                    and result.get("done")
                                    and descriptor.get("terminal")
                                ):
                                    completed = result
                        except Exception as caught:
                            error = caught
                            result = self.error_feedback(caught)
                            self.on_event(
                                "tool_error",
                                dict(name=call["function"]["name"], error=str(caught)),
                            )
                            if host:
                                host_failed = True
                        timing = dict(
                            startedAt=started,
                            durationMs=(time.perf_counter() - start) * 1000,
                        )
                        if span:
                            span.observation(call, args, result, timing, error)
                        if self.observe:
                            self.observe(call, result, dict(step=step, **timing))
                        # ⑤ 无论成功或错误，都成为下一轮可读取的观察。
                        state["trajectory"].append(
                            dict(type="preflight", result=result)
                            if host
                            else dict(type="observation", call=call, result=result)
                        )
                    state["progress"] = dict(step=step, toolCalls=phase_calls)
                    if self.checkpoint:
                        projected = await assembler.build(state)
                        self.checkpoint(
                            dict(
                                messages=projected["messages"],
                                trajectory=state["trajectory"],
                                step=step,
                            )
                        )
                    if token:
                        token.check()
                    if completed:
                        round_status = "completed"
                        return outcome("completed", completed)
                    if host_failed:
                        raise AppError(
                            "前置工具失败："
                            + state["trajectory"][-1]["result"]["error"]
                        )
                except Exception as error:
                    round_error = error
                    round_status = (
                        "cancelled" if isinstance(error, Cancelled) else "failed"
                    )
                finally:
                    if span:
                        span.end(round_status, round_error)
                if round_error:
                    failure = outcome(
                        "cancelled" if isinstance(round_error, Cancelled) else "failed",
                        error=round_error,
                    )
                    if await recover(failure):
                        continue
                    return failure
        except Exception as error:
            return outcome(
                "cancelled" if isinstance(error, Cancelled) else "failed", error=error
            )
