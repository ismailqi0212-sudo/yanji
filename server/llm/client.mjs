import { settings } from "../memory/store.mjs";
// OpenAI-compatible SSE transport. Tool argument fragments are assembled by index.
export async function model(
  messages,
  { tools, force, signal, onText, maxTokens = 4200 } = {},
) {
  const s = settings();
  if (!s.key) throw new Error("请先连接模型");
  const response = await fetch(
    s.baseUrl.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer " + s.key,
      },
      body: JSON.stringify({
        model: s.model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(new URL(s.baseUrl).hostname === "api.deepseek.com"
          ? { thinking: { type: "disabled" } }
          : {}),
        ...(tools
          ? {
              tools,
              tool_choice: force
                ? { type: "function", function: { name: force } }
                : "auto",
            }
          : {}),
      }),
      signal: signal || AbortSignal.timeout(100000),
    },
  );
  if (!response.ok) {
    await response.text();
    throw new Error("模型接口返回 " + response.status + "，请检查配置或额度");
  }
  if (response.headers.get("content-type")?.includes("application/json")) {
    const data = await response.json();
    return {
      ...data.choices[0].message,
      usage: data.usage?.total_tokens || 0,
      usageKnown: typeof data.usage?.total_tokens === "number",
    };
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    content = "",
    usage = 0,
    usageKnown = false;
  const calls = new Map();
  async function line(text) {
    if (!text.startsWith("data:")) return;
    const raw = text.slice(5).trim();
    if (raw === "[DONE]") return;
    const data = JSON.parse(raw);
    if (typeof data.usage?.total_tokens === "number") {
      usage = data.usage.total_tokens;
      usageKnown = true;
    }
    const delta = data.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      onText?.(content);
    }
    for (const t of delta.tool_calls || []) {
      const c = calls.get(t.index) || {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (t.id) c.id = t.id;
      if (t.function?.name) c.function.name += t.function.name;
      if (t.function?.arguments) c.function.arguments += t.function.arguments;
      calls.set(t.index, c);
    }
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const l of lines) await line(l.trim());
  }
  if (pending.trim()) await line(pending.trim());
  return {
    role: "assistant",
    content,
    tool_calls: [...calls.values()],
    usage,
    usageKnown,
  };
}
