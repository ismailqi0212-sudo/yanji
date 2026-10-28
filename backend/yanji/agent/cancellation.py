"""取消信号是一次运行的停止按钮；不会撤销已经提交的历史结果。"""

import asyncio
from ..common import AppError


class Cancelled(AppError):
    def __init__(self, message="任务已停止或超时"):
        super().__init__(message, code="CANCELLED")


class CancellationToken:
    """应用创建，Loop/模型/工具读取；不负责保存任务状态。"""

    def __init__(self, parent=None):
        self.event = asyncio.Event()
        self.parent = parent

    @property
    def cancelled(self):
        return self.event.is_set() or bool(self.parent and self.parent.cancelled)

    def cancel(self):
        self.event.set()

    def check(self):
        if self.cancelled:
            raise Cancelled()

    async def wait(self):
        if not self.parent:
            await self.event.wait()
            return
        tasks = [
            asyncio.create_task(self.event.wait()),
            asyncio.create_task(self.parent.wait()),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def cancellable(awaitable, token=None, timeout=None):
    """调用方等待 IO；取消时关闭协程并清理监听，不接受迟到结果。"""
    if token and token.cancelled:
        awaitable.close()
        token.check()
    work = asyncio.ensure_future(awaitable)
    stop = asyncio.create_task(token.wait()) if token else None
    try:
        done, _ = await asyncio.wait(
            [work, *([stop] if stop else [])],
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if not done or (token and token.cancelled):
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
            raise Cancelled("任务已停止或模型请求超时")
        return await work
    finally:
        if stop:
            stop.cancel()
            await asyncio.gather(stop, return_exceptions=True)
        if not work.done():
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
