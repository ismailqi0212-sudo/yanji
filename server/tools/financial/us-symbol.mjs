// Resolve exchange-qualified US identifiers from the provider, never guess NYSE/NASDAQ.
const cache = new Map(),
  pending = new Map();
export function parseUSSymbol(text, symbol) {
  if (!/^us[A-Z][A-Z0-9.-]{0,14}$/.test(symbol))
    throw new Error("美股代码格式不正确。");
  const match = text.match(/="([^"\n]*)"/),
    f = match?.[1].split("~");
  if (!f || f.length < 36 || f[0] !== "200" || !f[1])
    throw new Error("未找到该美股，请通过公司名称搜索后选择。");
  const ticker = f[2].toUpperCase(),
    parts = ticker.match(/^(.+)\.(OQ|N|AM)$/);
  if (!parts || parts[1] !== symbol.slice(2) || f[35] !== "USD")
    throw new Error("无法核实美股交易所或报价币种，请选择其他代码。");
  const markets = {
    OQ: { exchange: "NASDAQ", emMarket: "105" },
    N: { exchange: "NYSE", emMarket: "106" },
    AM: { exchange: "NYSE American", emMarket: "107" },
  };
  const market = markets[parts[2]];
  return {
    symbol,
    ticker: parts[1],
    providerSymbol: "us" + ticker,
    name: f[1],
    exchange: market.exchange,
    emSecid: market.emMarket + "." + parts[1],
    currency: "USD",
    timeZone: "America/New_York",
  };
}
export async function resolveUS(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < 86400000) return cached.value;
  if (pending.has(symbol)) return pending.get(symbol);
  const task = (async () => {
    try {
      const r = await fetch(
        "https://qt.gtimg.cn/q=" + encodeURIComponent(symbol),
        { signal: AbortSignal.timeout(12000) },
      );
      if (!r.ok) throw new Error("美股代码查询暂不可用。");
      const value = parseUSSymbol(
        new TextDecoder("gb18030").decode(await r.arrayBuffer()),
        symbol,
      );
      cache.set(symbol, { at: Date.now(), value });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    } finally {
      pending.delete(symbol);
    }
  })();
  pending.set(symbol, task);
  return task;
}
