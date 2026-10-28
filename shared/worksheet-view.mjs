/** Presentation only: never merge, convert, delete, or rewrite worksheet values. */
export function worksheetOverview(rows, limit = 8) {
  const count = (r) =>
    Object.values(r.cells).filter(
      (c) => Number.isFinite(c.value) && c.status !== "conflict",
    ).length;
  const conflicts = (r) =>
    Object.values(r.cells).some((c) => c.status === "conflict");
  const norm = (s) =>
    String(s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s/g, "");
  const business =
    /用户|客户|月活|付费|arpu|销量|产量|订单|门店|订阅|客单|业务|分部|segment|subscriber|volume/i;
  const candidates = rows
    .filter((r) => count(r) >= 2 && !conflicts(r))
    .map((r, index) => ({
      r,
      index,
      score: Math.min(count(r), 6) * 2 + (business.test(r.metric) ? 8 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const families = new Set(),
    ids = [];
  for (const { r } of candidates) {
    const key = [r.company, r.metric, r.currency].map(norm).join("|");
    if (families.has(key)) continue;
    families.add(key);
    ids.push(r.id);
    if (ids.length >= limit) break;
  }
  return {
    primaryIds: ids,
    reviewIds: rows.filter(conflicts).map((r) => r.id),
    total: rows.length,
  };
}
