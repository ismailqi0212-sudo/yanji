import { normalizeSymbol } from "./market.mjs";
async function get(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "YanjiResearch/1.0 (local desktop financial research)",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("公告源返回 " + r.status);
  return r.json();
}
let tickers;
export async function companyFilings(input) {
  const symbol = normalizeSymbol(input);
  if (symbol.startsWith("hk"))
    throw new Error(
      "港股公告目录暂未接入，请上传港交所公告；不以新闻标题替代公告原文",
    );
  if (symbol.startsWith("us")) {
    if (!tickers)
      tickers = await get("https://www.sec.gov/files/company_tickers.json");
    const company = Object.values(tickers).find(
      (x) => x.ticker === symbol.slice(2).replace(".", "-"),
    );
    if (!company) throw new Error("SEC未找到该代码");
    const cik = String(company.cik_str).padStart(10, "0"),
      raw = await get("https://data.sec.gov/submissions/CIK" + cik + ".json"),
      recent = raw.filings?.recent;
    if (!recent) throw new Error("暂未取得申报目录");
    const rows = recent.form
      .flatMap((form, i) =>
        ["10-K", "10-Q", "8-K", "20-F", "6-K"].includes(form)
          ? [
              {
                title:
                  form +
                  " · " +
                  (recent.primaryDocDescription?.[i] || "公司申报"),
                date: recent.filingDate[i],
                period: recent.reportDate[i],
                url:
                  "https://www.sec.gov/Archives/edgar/data/" +
                  Number(cik) +
                  "/" +
                  recent.accessionNumber[i].replaceAll("-", "") +
                  "/" +
                  recent.primaryDocument[i],
              },
            ]
          : [],
      )
      .slice(0, 8);
    return {
      symbol,
      name: raw.name,
      source: "SEC EDGAR申报目录",
      sourceUrl: "https://www.sec.gov/edgar/browse/?CIK=" + cik,
      rows,
      note: "仅目录与公开链接，尚未读取正文，不能从文件标题推断经营影响。",
      fetchedAt: new Date().toISOString(),
    };
  }
  const raw = await get(
    "https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=8&page_index=1&ann_type=A&client_source=web&stock_list=" +
      symbol.slice(2),
  );
  if (!Array.isArray(raw.data?.list)) throw new Error("暂无公告目录");
  const rows = raw.data.list
    .filter((x) => x.codes?.some((c) => c.stock_code === symbol.slice(2)))
    .map((x) => ({
      title: x.title,
      date: x.notice_date?.slice(0, 10),
      url:
        "https://data.eastmoney.com/notices/detail/" +
        symbol.slice(2) +
        "/" +
        x.art_code +
        ".html",
    }));
  return {
    symbol,
    name:
      raw.data.list[0]?.codes?.find((c) => c.stock_code === symbol.slice(2))
        ?.short_name || symbol,
    source: "东方财富公司公告目录",
    sourceUrl:
      "https://data.eastmoney.com/notices/stock/" + symbol.slice(2) + ".html",
    rows,
    note: "目录索引，尚未读取公告正文；请打开原文核验或上传后研究。",
    fetchedAt: new Date().toISOString(),
  };
}
