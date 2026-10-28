import { toolEffects } from "../../research/effects.mjs";
/** External financial adapters preserve provenance and produce reusable artifacts. */
import { FinancialToolsManager } from "../../upstream/financial-tools.mjs";
import { financialComparisons } from "../../research/comparisons.mjs";
import { quoteData } from "./quote.mjs";
import { marketData, normalizeSymbol } from "./market.mjs";
import { financialData } from "./financials.mjs";
import { now } from "../../memory/store.mjs";
import { makeCard } from "../../research/artifacts.mjs";
export function createFinancialTools({
  cid,
  run,
  seen,
  calculations,
  effects,
  financialCache,
}) {
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return new FinancialToolsManager(
    {
      getStockPrices: async ({ ticker }) => {
        event(cid, run.id, "查询行情与估值", ticker);
        const [price, quote] = await Promise.allSettled([
          marketData(ticker),
          quoteData(ticker),
        ]);
        if (price.status === "rejected" && quote.status === "rejected")
          throw new Error("行情源暂不可用，请稍后再试");
        const data = {
          ...(price.status === "fulfilled" ? price.value : {}),
          ...(quote.status === "fulfilled" ? { quote: quote.value } : {}),
          fetchedAt: now(),
          sourceUrl:
            price.status === "fulfilled"
              ? price.value.sourceUrl
              : quote.value.sourceUrl,
        };
        const source = addSource(cid, data, "行情与估值 · " + ticker);
        seen.add(source.id);
        addArtifact(
          cid,
          run.id,
          makeCard(
            "market",
            data.name || ticker,
            { ...data, bars: data.bars?.slice(-120) },
            [source.id],
          ),
        );
        return { sourceId: source.id, ...data, bars: data.bars?.slice(-10) };
      },
      getIncomeStatements: async ({ ticker, years, frequency }) => {
        event(cid, run.id, "查询年度财务", ticker);
        const data = await financialData(
            ticker,
            years || 3,
            frequency || "annual",
          ),
          source = addSource(
            cid,
            data,
            (frequency === "latest" ? "最新累计财务 · " : "年度财务 · ") +
              data.name,
          );
        seen.add(source.id);
        addArtifact(
          cid,
          run.id,
          makeCard(
            "financials",
            data.name +
              (frequency === "latest" ? " · 累计期财务" : " · 年度财务"),
            data,
            [source.id],
          ),
        );
        const computed = financialComparisons([
          { kind: "financials", data, sourceIds: [source.id] },
        ]);
        calculations.push(...computed);
        return { sourceId: source.id, ...data, computed };
      },
      getFinancialMetrics: async ({ ticker }) => {
        const existing = getProject(cid).cards.find(
          (x) =>
            x.kind === "market" && x.data.symbol === normalizeSymbol(ticker),
        );
        if (existing)
          return { sourceId: existing.sourceIds[0], ...existing.data.quote };
        event(cid, run.id, "查询财务指标", ticker);
        const data = await quoteData(ticker),
          source = addSource(cid, data, "估值指标 · " + ticker);
        seen.add(source.id);
        addArtifact(
          cid,
          run.id,
          makeCard("market", data.name, { quote: data }, [source.id]),
        );
        return { sourceId: source.id, ...data };
      },
    },
    financialCache,
  );
}
