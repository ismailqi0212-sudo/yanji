import { resolveUS } from "./us-symbol.mjs";
// Public website market data, not an exchange-authorized realtime feed.
// Tencent field layout is cross-checked against AKShare's stock_hist_tx adapter.
const cache = new Map(),
  pending = new Map();
const TTL = 10 * 60 * 1000,
  STALE_TTL = 24 * 60 * 60 * 1000;
export function normalizeSymbol(input) {
  const raw = String(input || "")
    .trim()
    .replace(/\s+/g, "");
  let s = raw.toLowerCase();
  if (!/^(sh|sz|bj)[.:]?\d{6}$/i.test(raw) && !/^hk[.:]?\d{1,5}$/i.test(raw)) {
    const ticker = raw
      .replace(/^(NASDAQ|NYSE|AMEX):/i, "")
      .replace(/^us(?=[A-Z])/, "")
      .replace(/^US[:.]/, "")
      .replace(/\.US$/i, "")
      .replace(/\.(OQ|N|AM)$/i, "")
      .toUpperCase();
    if (/^[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?$/.test(ticker))
      return "us" + ticker;
  }
  const hk = s.match(/^(?:hk[.:]?(\d{1,5})|(\d{1,5})\.hk|(\d{5}))$/);
  if (hk) {
    const code = (hk[1] || hk[2] || hk[3]).padStart(5, "0");
    if (Number(code) === 0 || Number(code) >= 10000)
      throw new Error(
        "当前仅支持港币普通股代码，不支持认股权证或其他币种柜台。",
      );
    return "hk" + code;
  }
  let explicit = "";
  const suffix = s.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (suffix) {
    s = suffix[1];
    explicit = suffix[2];
  } else {
    const prefix = s.match(/^(sh|sz|bj)[.:]?(\d{6})$/);
    if (prefix) {
      s = prefix[2];
      explicit = prefix[1];
    }
  }
  if (!/^\d{6}$/.test(s))
    throw new Error("请输入证券代码，例如 002027、01024.HK 或 AAPL。");
  let exchange;
  if (/^(600|601|603|605|688|689)/.test(s)) exchange = "sh";
  else if (/^(000|001|002|003|300|301)/.test(s)) exchange = "sz";
  else if (/^(4|8|920)/.test(s)) exchange = "bj";
  else throw new Error("当前支持 A 股、港股普通股与美股证券。请核对代码。");
  if (explicit && explicit !== exchange)
    throw new Error("代码与交易所不匹配，请检查后重试。");
  return exchange + s;
}
export function parseTencent(json, symbol, adjust = "qfq", metadata = null) {
  if (json.code !== 0 || !json.data?.[symbol])
    throw new Error("数据源未找到该股票，请核对证券代码。");
  const data = json.data[symbol],
    key = adjust === "qfq" && data.qfqday?.length ? "qfqday" : "day",
    rows = data[key];
  if (!Array.isArray(rows) || !rows.length)
    throw new Error("该股票暂无可用日线。");
  const bars = new Map();
  for (const r of rows) {
    if (!Array.isArray(r) || !/^\d{4}-\d{2}-\d{2}$/.test(r[0])) continue;
    const date = new Date(r[0] + "T00:00:00Z");
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== r[0]
    )
      continue;
    const [open, close, high, low, rawVolume] = r.slice(1, 6).map(Number);
    if (
      ![open, close, high, low, rawVolume].every(Number.isFinite) ||
      open <= 0 ||
      close <= 0 ||
      low <= 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close) ||
      rawVolume < 0
    )
      continue;
    const volume =
      rawVolume *
      (symbol.startsWith("sh688") ||
      symbol.startsWith("sh689") ||
      symbol.startsWith("hk") ||
      symbol.startsWith("us")
        ? 1
        : 100);
    bars.set(r[0], { time: r[0], open, close, high, low, volume });
  }
  const result = [...bars.values()].sort((a, b) =>
    a.time.localeCompare(b.time),
  );
  if (!result.length) throw new Error("日线数据不完整，暂无法展示。");
  const qt = data.qt?.[symbol];
  return {
    symbol: metadata?.symbol || symbol,
    name: qt?.[1] || metadata?.name || symbol,
    code: metadata?.ticker || symbol.slice(2),
    exchange: metadata?.exchange || symbol.slice(0, 2).toUpperCase(),
    currency: metadata?.currency || (symbol.startsWith("hk") ? "HKD" : "CNY"),
    timeZone:
      metadata?.timeZone ||
      (symbol.startsWith("hk") ? "Asia/Hong_Kong" : "Asia/Shanghai"),
    source: "腾讯证券公开行情",
    sourceUrl: `https://gu.qq.com/${symbol}/gp`,
    adjustment: key === "qfqday" ? "前复权" : "不复权",
    adjustmentNote:
      adjust === "qfq" && key === "day" ? "数据源本次仅返回不复权日线。" : "",
    volumeUnit: "股",
    latestDate: result.at(-1).time,
    bars: result,
  };
}
async function fetchTencent(symbol, adjust) {
  const metadata = symbol.startsWith("us") ? await resolveUS(symbol) : null;
  const providerSymbol = metadata?.providerSymbol || symbol;
  const url = new URL(
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
  );
  url.searchParams.set(
    "param",
    `${providerSymbol},day,,,640,${adjust === "qfq" ? "qfq" : ""}`,
  );
  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "ThesisLedger/1.0 (personal research)",
    },
    signal: AbortSignal.timeout(18000),
  });
  if (!r.ok) throw new Error("行情数据源暂不可用，请稍后重试。");
  return parseTencent(await r.json(), providerSymbol, adjust, metadata);
}
export async function marketData(input, adjust = "qfq", refresh = false) {
  if (!["qfq", "none"].includes(adjust)) throw new Error("不支持此复权口径。");
  const symbol = normalizeSymbol(input),
    key = symbol + ":" + adjust,
    stored = cache.get(key);
  if (stored && Date.now() - stored.saved < (refresh ? 30000 : TTL))
    return { ...stored.data, cached: true, stale: false };
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    try {
      const raw = await fetchTencent(symbol, adjust);
      const data = { ...raw, fetchedAt: new Date().toISOString() };
      cache.set(key, { saved: Date.now(), data });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return { ...data, cached: false, stale: false };
    } catch (e) {
      if (stored && Date.now() - stored.saved < STALE_TTL)
        return {
          ...stored.data,
          cached: true,
          stale: true,
          warning: "行情源暂不可用，展示最近缓存。",
        };
      throw new Error(
        e.name === "TimeoutError"
          ? "行情请求超时，请稍后重试。"
          : e.message === "fetch failed"
            ? "无法连接公开行情源，请检查网络后重试。"
            : e.message,
      );
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return task;
}
const searchCache = new Map();
export function parseSearch(text) {
  const match = text.match(/v_hint\s*=\s*"([^"\n]*)"/);
  if (!match) return [];
  let decoded;
  try {
    decoded = JSON.parse('"' + match[1] + '"');
  } catch {
    throw new Error("证券搜索返回格式异常，请直接输入代码。");
  }
  const out = [];
  for (const row of decoded.split("^")) {
    const [exchange, code, name, , type] = row.split("~");
    if (
      !["GP", "GP-A"].includes(type) ||
      !["sh", "sz", "bj", "hk", "us"].includes(exchange)
    )
      continue;
    try {
      const symbol = normalizeSymbol(
        exchange + (exchange === "us" ? code.toUpperCase() : code),
      );
      out.push({
        symbol,
        code: symbol.slice(2),
        exchange:
          exchange === "us"
            ? /\.oq$/i.test(code)
              ? "NASDAQ"
              : /\.n$/i.test(code)
                ? "NYSE"
                : /\.am$/i.test(code)
                  ? "NYSE American"
                  : "US"
            : exchange.toUpperCase(),
        name,
      });
    } catch {}
  }
  return out.slice(0, 8);
}
export async function searchSymbols(input) {
  const q = String(input || "").trim();
  if (q.length < 2) return [];
  if (q.length > 40 || !/[\p{L}\p{N}]/u.test(q))
    throw new Error("请输入公司名称或证券代码。");
  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.at < 300000) return cached.rows;
  const url = new URL("https://smartbox.gtimg.cn/s3/");
  url.searchParams.set("q", q);
  url.searchParams.set("t", "all");
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error();
    const rows = parseSearch(
      new TextDecoder("gb18030").decode(await r.arrayBuffer()),
    );
    searchCache.set(q, { at: Date.now(), rows });
    if (searchCache.size > 100)
      searchCache.delete(searchCache.keys().next().value);
    return rows;
  } catch {
    throw new Error("证券搜索暂不可用，可直接输入代码绑定。");
  }
}
