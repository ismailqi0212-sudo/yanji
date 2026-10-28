export async function api<T = any>(
  url: string,
  method = "GET",
  body?: any,
): Promise<T> {
  const r = await fetch("/api" + url, {
    method,
    headers: {
      "x-yanji-client": "1",
      ...(body !== undefined && !(body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  if (!r.ok) {
    const error = await r.json().catch(() => ({ error: "无法连接本地服务" }));
    throw new Error(error.error);
  }
  return r.json();
}
