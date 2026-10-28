"""为一次运行装配隔离实例；子Agent接口默认关闭，不会自行创建角色。"""

from ..common import AppError, uid, clone
from .cancellation import CancellationToken
from .loop import AgentLoop


class AgentRuntimeFactory:
    def __init__(self, assemble, allow_children=False, max_depth=1, max_children=1):
        self.assemble, self.allow_children = assemble, allow_children
        self.max_depth, self.max_children = max_depth, max_children

    def create(
        self,
        session_id,
        run_id=None,
        *,
        parent_run_id=None,
        categories=None,
        source_mode=None,
        token=None,
        max_steps=9,
        max_tool_calls=32,
        depth=0,
    ):
        """应用调用；仅创建权限范围，真正执行由run触发。"""
        return Runtime(
            self,
            dict(
                sessionId=session_id,
                runId=run_id or uid(),
                parentRunId=parent_run_id,
                categories=categories,
                sourceMode=source_mode,
                depth=depth,
            ),
            CancellationToken(token),
            max_steps,
            max_tool_calls,
        )


class Runtime:
    """拥有一次执行与取消信号；不持有具体金融工具实现。"""

    def __init__(self, factory, scope, token, max_steps, max_tool_calls):
        self.factory, self._scope, self.token = factory, clone(scope), token
        self.max_steps, self.max_tool_calls = max_steps, max_tool_calls
        self.used = False
        self.children = 0

    @property
    def scope(self):
        """调用方可查看范围快照；修改快照不能扩大内部运行权限。"""
        return clone(self._scope)

    async def run(self, state=None, **config):
        if self.used:
            raise AppError("运行实例已使用，请创建新实例")
        if (
            config.get("max_steps", self.max_steps) > self.max_steps
            or config.get("max_tool_calls", self.max_tool_calls) > self.max_tool_calls
        ):
            raise AppError("不能扩大运行预算")
        recovery = config.get("recovery")
        if recovery and (
            recovery["max_steps"] > self.max_steps
            or recovery["max_tool_calls"] > max(1, self.max_tool_calls)
        ):
            raise AppError("恢复预算超出运行范围")
        self.used = True
        dependencies = await self.factory.assemble(self.scope, self.token)
        upstream = dependencies["registry"]
        scope = self.scope

        class ScopedRegistry:
            def list(self):
                return [
                    e
                    for e in upstream.list()
                    if (
                        not scope["categories"]
                        or e.get("category") in scope["categories"]
                    )
                    and (
                        not scope["sourceMode"]
                        or not e.get("sourceModes")
                        or scope["sourceMode"] in e["sourceModes"]
                    )
                ]

            async def invoke(self, name, args, metadata=None):
                if name not in {e["name"] for e in self.list()}:
                    raise AppError("运行范围不允许调用此工具")
                return await upstream.invoke(name, args, metadata)

        dependencies["registry"] = ScopedRegistry()
        state = {**(state or {}), **scope}
        state["task"] = {
            **state.get("task", {}),
            "sourceMode": scope["sourceMode"]
            or state.get("task", {}).get("sourceMode"),
        }
        config.setdefault("max_steps", self.max_steps)
        config.setdefault("max_tool_calls", self.max_tool_calls)
        return await AgentLoop(**dependencies).run(state, token=self.token, **config)

    def create_child(
        self, *, categories=None, source_mode=None, max_steps=None, max_tool_calls=None
    ):
        """未来委派工具调用；子任务只能缩小权限和预算。"""
        scope = self.scope
        if (
            not self.factory.allow_children
            or scope["depth"] >= self.factory.max_depth
            or self.children >= self.factory.max_children
        ):
            raise AppError("子运行未启用或达到上限")
        categories = categories or scope["categories"]
        if scope["categories"] and any(
            c not in scope["categories"] for c in categories
        ):
            raise AppError("子运行不能扩大工具分类权限")
        source_mode = source_mode or scope["sourceMode"]
        if (
            scope["sourceMode"] not in (None, "hybrid")
            and source_mode != scope["sourceMode"]
        ):
            raise AppError("子运行不能扩大资料范围")
        if (max_steps or self.max_steps) > self.max_steps or (
            max_tool_calls or self.max_tool_calls
        ) > self.max_tool_calls:
            raise AppError("子运行不能扩大预算")
        self.children += 1
        return self.factory.create(
            scope["sessionId"],
            parent_run_id=scope["runId"],
            categories=categories,
            source_mode=source_mode,
            token=self.token,
            max_steps=max_steps or self.max_steps,
            max_tool_calls=max_tool_calls or self.max_tool_calls,
            depth=scope["depth"] + 1,
        )
