"""模型通信与调用记账。模型只提出动作，不能直接写业务数据库。"""

import json
import time
from urllib.parse import urlsplit
import httpx
from ..common import AppError, clone, error_data, now, uid
from ..agent.cancellation import Cancelled, cancellable


class ModelClient:
    """应用注入设置读取器；只负责 OpenAI 兼容 HTTP/SSE，不拼提示词。"""

    def __init__(self, settings, client=None):
        self.settings, self.client = settings, client

    async def __call__(
        self, messages, *, tools=None, force=None, max_tokens=4200, on_text=None
    ):
        settings = self.settings()
        if not settings["key"]:
            raise AppError("请先连接模型")
        payload = dict(
            model=settings["model"],
            messages=messages,
            temperature=0.2,
            max_tokens=max_tokens,
            stream=True,
            stream_options={"include_usage": True},
        )
        if urlsplit(settings["baseUrl"]).hostname == "api.deepseek.com":
            payload["thinking"] = {"type": "disabled"}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = (
                {"type": "function", "function": {"name": force}} if force else "auto"
            )
        client = self.client or httpx.AsyncClient(
            timeout=httpx.Timeout(120, connect=20), trust_env=True
        )
        try:
            async with client.stream(
                "POST",
                settings["baseUrl"].rstrip("/") + "/chat/completions",
                headers={
                    "Authorization": "Bearer " + settings["key"],
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    raise AppError(
                        f"模型接口返回 {response.status_code}，请检查配置或额度"
                    )
                if "application/json" in response.headers.get("content-type", ""):
                    data = json.loads(await response.aread())
                    return {
                        **data["choices"][0]["message"],
                        "usage": data.get("usage", {}).get("total_tokens", 0),
                        "usageKnown": "total_tokens" in data.get("usage", {}),
                    }
                content = ""
                calls = {}
                usage = 0
                known = False
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    data = json.loads(raw)
                    if (
                        isinstance(data.get("usage"), dict)
                        and "total_tokens" in data["usage"]
                    ):
                        usage = data["usage"]["total_tokens"]
                        known = True
                    choices = data.get("choices") or []
                    delta = choices[0].get("delta", {}) if choices else {}
                    if delta.get("content"):
                        content += delta["content"]
                        if on_text:
                            on_text(content)
                    for fragment in delta.get("tool_calls", []):
                        call = calls.setdefault(
                            fragment["index"],
                            dict(
                                id="",
                                type="function",
                                function=dict(name="", arguments=""),
                            ),
                        )
                        if fragment.get("id"):
                            call["id"] = fragment["id"]
                        for key in ("name", "arguments"):
                            call["function"][key] += (
                                fragment.get("function", {}).get(key, "") or ""
                            )
                return dict(
                    role="assistant",
                    content=content,
                    tool_calls=list(calls.values()),
                    usage=usage,
                    usageKnown=known,
                )
        finally:
            if not self.client:
                await client.aclose()


class ModelService:
    """Loop/复合工具调用的统一端口；记账与取消，不决定行动、不构造输入。"""

    def __init__(self, transport, recorder, metadata, token=None, timeout=120):
        self.transport, self.recorder, self.metadata = (
            transport,
            recorder,
            clone(metadata),
        )
        self.token, self.timeout = token, timeout

    def scope(self, **metadata):
        """工具流水线创建带父callId的端口；不共享可变元数据，不另起Agent。"""
        return ModelService(
            self.transport,
            self.recorder,
            {**self.metadata, **metadata},
            self.token,
            self.timeout,
        )

    async def complete(self, messages, metadata=None, **options):
        """Loop或复合工具请求一次模型调用；负责取消与记账，不解释金融结果。"""
        if self.token:
            self.token.check()
        call = {
            **self.metadata,
            **(metadata or {}),
            "id": uid(),
            "startedAt": now(),
            "status": "running",
        }
        self.recorder.start_model_call(call)
        start = time.perf_counter()
        response = None
        error = None
        try:
            response = await cancellable(
                self.transport(messages, **options), self.token, self.timeout
            )
            if self.token:
                self.token.check()
            return response
        except BaseException as caught:
            error = caught
            raise
        finally:
            call.update(
                finishedAt=now(),
                durationMs=(time.perf_counter() - start) * 1000,
                status="cancelled"
                if isinstance(error, Cancelled) or self.token and self.token.cancelled
                else "failed"
                if error
                else "completed",
                usage=response.get("usage", 0) if response else 0,
                usageKnown=response.get(
                    "usageKnown", isinstance(response.get("usage"), (int, float))
                )
                if response
                else False,
                error=error_data(error) if error else None,
            )
            if response:
                call["decision"] = {
                    k: clone(response[k])
                    for k in ("content", "tool_calls", "decision")
                    if k in response
                }
            self.recorder.finish_model_call(call)
