import { normalizeSymbol } from "./market.mjs";
import { resolveUS } from "./us-symbol.mjs";
const cache = new Map(),
  pending = new Map();
const TTL = 5 * 60 * 1000,
  STALE_TTL = 24 * 60 * 60 * 1000;
const fields =
  "f57,f58,f43,f60,f86,f116,f117,f162,f163,f164,f167,f168,f47,f48,f171,f84,f85";
export function sourceNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (
    typeof value === "string" &&
    (!value.trim() || !/^[-+]?\d+(\.\d+)?$/.test(value.trim()))
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const positive = (v) => {
  const n = sourceNumber(v);
  return n !== null && n > 0 ? n : null;
};
const nonnegative = (v) => {
  const n = sourceNumber(v);
  return n !== null && n >= 0 ? n : null;
};
const multiple = (v) => {
  const n = sourceNumber(v);
  return n === 0 ? null : n;
};
export function parseQuote(json, input, metadata = null) {
  const symbol = normalizeSymbol(input),
    d = json?.data;
  if (
    json?.rc !== 0 ||
    !d ||
    String(d.f57).toUpperCase() !== symbol.slice(2).toUpperCase() ||
    typeof d.f58 !== "string"
  )
    throw new Error("估值数据源未返回该股票的有效快照。");
  const hk = symbol.startsWith("hk"),
    us = symbol.startsWith("us"),
    volume = nonnegative(d.f47),
    epoch = sourceNumber(d.f86);
  const asOf =
    epoch !== null && epoch > 1e9 && epoch < 4.2e9
      ? new Date(epoch * 1000).toISOString()
      : null;
  return {
    symbol,
    name: d.f58,
    currency: us ? "USD" : hk ? "HKD" : "CNY",
    timeZone: us ? "America/New_York" : hk ? "Asia/Hong_Kong" : "Asia/Shanghai",
    source: "东方财富公开报价",
    sourceUrl: us
      ? `https://quote.eastmoney.com/us/${symbol.slice(2)}.html`
      : hk
        ? `https://quote.eastmoney.com/hk/${symbol.slice(2)}.html`
        : `https://quote.eastmoney.com/${symbol}.html`,
    asOf,
    metrics: {
      peTtm: multiple(d.f164),
      peStatic: multiple(d.f163),
      peDynamic: multiple(d.f162),
      pb: multiple(d.f167),
      marketCap: positive(d.f116),
      floatMarketCap: positive(d.f117),
      turnoverRate: nonnegative(d.f168),
      turnoverAmount: nonnegative(d.f48),
      volume: volume === null ? null : volume * (hk || us ? 1 : 100),
      amplitude: nonnegative(d.f171),
      totalShares: positive(d.f84),
      floatShares: positive(d.f85),
    },
    conventions: {
      peTtm: "滚动市盈率，数据源 TTM 口径；不等同于一致预期市盈率。",
      peStatic: "静态市盈率，数据源静态口径。",
      peDynamic: "动态市盈率，数据源动态口径；不等同于分析师预测。",
      pb: "市净率，按数据源最新可用净资产口径。",
      currency: us
        ? "市值、成交额为美元；成交量和股本为股。"
        : hk
          ? "市值、成交额为港元；成交量和股本为股。"
          : "市值、成交额为人民币元；成交量和股本为股。",
      asOf: "报价时间不代表财务报表截止日；当前快照不随历史走势图范围变化。",
    },
  };
}
async function fetchQuote(symbol) {
  const metadata = symbol.startsWith("us") ? await resolveUS(symbol) : null;
  const secid =
    metadata?.emSecid ||
    (symbol.startsWith("hk") ? "116." : symbol.startsWith("sh") ? "1." : "0.") +
      symbol.slice(2);
  const url = new URL("https://push2.eastmoney.com/api/qt/stock/get");
  url.searchParams.set("secid", secid);
  url.searchParams.set("fltt", "2");
  url.searchParams.set("fields", fields);
  const r = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: {
      Accept: "application/json",
      "User-Agent": "ThesisLedger/1.0 (personal research)",
    },
  });
  if (!r.ok) throw new Error("估值数据源暂不可用，请稍后重试。");
  return parseQuote(await r.json(), symbol, metadata);
}
export async function quoteData(input, refresh = false) {
  const symbol = normalizeSymbol(input),
    stored = cache.get(symbol);
  if (stored && Date.now() - stored.saved < (refresh ? 30000 : TTL))
    return { ...stored.data, cached: true, stale: false };
  if (pending.has(symbol)) return pending.get(symbol);
  const task = (async () => {
    try {
      const data = {
        ...(await fetchQuote(symbol)),
        fetchedAt: new Date().toISOString(),
      };
      cache.set(symbol, { saved: Date.now(), data });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return { ...data, cached: false, stale: false };
    } catch (e) {
      if (stored && Date.now() - stored.saved < STALE_TTL)
        return {
          ...stored.data,
          cached: true,
          stale: true,
          warning: "估值数据源暂不可用，展示最近缓存。",
        };
      throw new Error(
        e.name === "TimeoutError"
          ? "指标请求超时，可稍后重试；走势图仍可使用。"
          : e.message === "fetch failed"
            ? "暂时无法连接指标数据源；走势图仍可使用。"
            : e.message,
      );
    } finally {
      pending.delete(symbol);
    }
  })();
  pending.set(symbol, task);
  return task;
}
