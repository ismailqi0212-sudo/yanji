"""工具唯一的注册、发现与调用入口。新增工具不用修改 AgentLoop。"""

import inspect
import asyncio
import jsonschema
from ..common import AppError, clone


class ToolRegistry:
    """装配方注册描述和loader；Loop只依赖list/invoke，本类不实现金融业务。"""

    def __init__(
        self,
        entries=(),
        context=None,
        execution=None,
        *,
        categories=None,
        source_mode=None,
        mode="research",
    ):
        self.entries = {}
        self.handlers = {}
        self.loading = {}
        self.context = context
        self.execution = execution
        self.categories, self.source_mode, self.mode = categories, source_mode, mode
        for entry in entries:
            self.register(entry)

    def register(self, entry):
        """应用装配方增加描述与loader；只登记能力，不立即加载或执行业务。"""
        if entry["name"] in self.entries:
            raise ValueError("工具重复注册：" + entry["name"])
        if (
            not callable(entry.get("load"))
            or entry.get("parameters", {}).get("type") != "object"
        ):
            raise ValueError("工具缺少schema或loader")
        self.entries[entry["name"]] = {
            **clone({k: v for k, v in entry.items() if k != "load"}),
            "load": entry["load"],
        }

    def enabled(self, entry):
        return (
            (not self.categories or entry.get("category") in self.categories)
            and (
                not self.source_mode
                or not entry.get("sourceModes")
                or self.source_mode in entry["sourceModes"]
            )
            and (not entry.get("modes") or self.mode in entry["modes"])
        )

    def list(self, categories: list[str] | None = None) -> list[dict]:
        """Loop/Assembler发现当前允许工具；返回说明副本，不暴露loader。"""
        return [
            clone({k: v for k, v in entry.items() if k != "load"})
            for entry in self.entries.values()
            if self.enabled(entry)
            and (not categories or entry.get("category") in categories)
        ]

    async def invoke(self, name: str, args: dict, metadata: dict | None = None):
        """Loop请求执行工具；检查权限与参数，再交给执行端口，不拼提示词。"""
        entry = self.entries.get(name)
        if not entry or not self.enabled(entry):
            raise AppError(
                "未知工具或当前资料范围禁止调用此工具", code="TOOL_FORBIDDEN"
            )
        if not isinstance(args, dict):
            raise AppError("工具参数必须是对象")
        try:
            jsonschema.validate(args, entry["parameters"])
        except jsonschema.ValidationError as error:
            raise AppError(
                "工具参数不符合说明：" + error.message, code="INVALID_ARGUMENTS"
            ) from error
        if name not in self.handlers:

            async def load():
                handler = entry["load"]()
                result = await handler if inspect.isawaitable(handler) else handler
                if not callable(result):
                    raise ValueError("工具loader未返回执行函数")
                return result

            if name not in self.loading:
                self.loading[name] = asyncio.create_task(load())
            loading = self.loading[name]
            try:
                self.handlers[name] = await asyncio.shield(loading)
            except BaseException:
                if loading.done() and self.loading.get(name) is loading:
                    self.loading.pop(name, None)
                raise
        handler = self.handlers[name]
        if self.execution:
            return await self.execution.run(entry, args, metadata or {}, handler)
        return await handler(args, self.context)
