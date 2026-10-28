import { financialComparisons } from "../research/comparisons.mjs";
import { evidence } from "../tools/documents/documents.mjs";
export function reportComputations(initial, cards, sourceIds) {
  // A selected finding still depends on its financial source, even when the
  // user does not select the raw financial-table card as a report appendix.
  const comparisonCards = [...cards];
  for (const sid of sourceIds) {
    const source = evidence(initial, sid);
    if (
      source?.data?.rows?.length &&
      source.data.frequency &&
      !cards.some(
        (card) => card.kind === "financials" && card.sourceIds.includes(sid),
      )
    )
      comparisonCards.push({
        kind: "financials",
        data: source.data,
        sourceIds: [sid],
      });
  }
  return [
    ...financialComparisons(comparisonCards),
    ...initial.runs.flatMap((r) =>
      (r.records || [])
        .filter(
          (x) =>
            x.name === "calculate" &&
            x.result?.result !== undefined &&
            x.result.sourceIds?.length &&
            x.result.sourceIds.every((sid) => sourceIds.includes(sid)),
        )
        .map((x) => x.result),
    ),
  ];
}
