"""模块间的显式端口：实现可以替换，调用方不需要读写对方内部状态。

这些是接口说明而非另一套框架。真实实现分别位于对应目录。
"""

from typing import Any, Protocol


class RegistryPort(Protocol):
    """Loop发现/调用工具；不要求调用方知道业务实现。"""

    def list(self, categories: list[str] | None = None) -> list[dict]: ...
    async def invoke(
        self, name: str, args: dict, metadata: dict | None = None
    ) -> Any: ...


class ContextPort(Protocol):
    """Loop按轮次请求上下文；不在Loop中拼提示词。"""

    async def build(self, state: dict) -> dict: ...


class MemoryProviderPort(Protocol):
    """Assembler检索记忆；不把检索结果当成系统指令。"""

    async def retrieve(self, scope: dict) -> dict: ...


class ModelPort(Protocol):
    """Loop/复合工具请求一次模型IO；不替它们决定任务目标。"""

    async def complete(self, messages: list[dict], **options: Any) -> dict: ...


class VerifierPort(Protocol):
    """提交流水线询问是否接纳候选；验证器不能直接写数据库。"""

    async def verify(self, observation: dict, context: dict) -> dict: ...


class TracePort(Protocol):
    """运行装配方注入持久化端口；不在轨迹层调用模型。"""

    def begin_step(self, cid: str, rid: str, metadata: dict) -> Any: ...
    def observe(
        self, cid: str, rid: str, call: dict, result: Any, metadata: dict
    ) -> None: ...
    def checkpoint(
        self, cid: str, rid: str, state: dict, seen: Any = (), calculations: Any = ()
    ) -> None: ...
    def finish(self, cid: str, rid: str, outcome: dict) -> None: ...
