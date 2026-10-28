/** Pure short-term projection; no implicit database initialization. */
// Historical artifacts are pointers plus bounded summaries; full raw data stays in storage.
const compactCard = (card) => ({
  id: card.id,
  title: card.title,
  kind: card.kind,
  version: card.version,
  data:
    card.kind === "documentAnalysis"
      ? {
          documentId: card.data.documentId,
          note: "完整分析在材料缓存中，按需读取",
        }
      : card.kind === "worksheet"
        ? {
            periods: card.data.periods,
            rows: card.data.rows.slice(0, 8).map((r) => ({
              ...r,
              cells: Object.fromEntries(
                Object.entries(r.cells).map(([p, c]) => [
                  p,
                  {
                    value: c.value,
                    status: c.status,
                    sourceIds: c.sourceIds,
                    formula: c.formula,
                  },
                ]),
              ),
            })),
            notes: card.data.notes,
          }
        : card.kind === "brief"
          ? { ...card.data, body: card.data.body?.slice(0, 2600) }
          : { ...card.data, bars: undefined, rows: card.data.rows?.slice(-6) },
  sourceIds: card.sourceIds.slice(0, 16),
});
export function documentSourceIds(chat) {
  return new Set(chat.documents.flatMap((d) => d.chunks.map((c) => c.id)));
}
export function permittedCard(chat, card, run) {
  if (run?.sourceMode === "external") {
    const external = new Set((chat.researchSources || []).map((s) => s.id));
    return (
      card.sourceIds.length > 0 &&
      card.sourceIds.every((id) => external.has(id))
    );
  }
  if (run?.sourceMode !== "documents") return true;
  const ids = documentSourceIds(chat);
  return (
    card.data?.fromMaterials ||
    (card.sourceIds.length && card.sourceIds.every((id) => ids.has(id)))
  );
}
export function sessionContext(
  chat,
  run,
  today = new Date().toISOString().slice(0, 10),
) {
  const recalled = new Set();
  const history = chat.messages.slice(-8, -2).map((message) => ({
    role: message.role,
    content:
      (message.role === "assistant" &&
      run.sourceMode !== "hybrid" &&
      !(message.cardIds || []).some((id) => {
        const c = chat.cards.find((c) => c.id === id);
        return c && permittedCard(chat, c, run);
      })
        ? "此前不在本轮资料范围内的回答不作为证据。"
        : message.text) +
      "\n" +
      (message.cardIds || [])
        .map((id) => {
          if (recalled.has(id)) return "";
          recalled.add(id);
          const card = chat.cards.find((card) => card.id === id);
          return card && permittedCard(chat, card, run)
            ? JSON.stringify(compactCard(card)).slice(0, 9000)
            : "";
        })
        .join("\n"),
  }));
  const report = chat.report && {
    title: chat.report.title,
    version: chat.report.version,
    stale: chat.report.stale,
    sections: chat.report.sections,
  };
  const projectMemory = {
    today,
    sourceMode: run.sourceMode,
    materials: (run.sourceMode === "external" ? [] : chat.documents).map(
      (d) => ({
        id: d.id,
        name: d.name,
        pages: d.pages.length,
      }),
    ),
    confirmed: chat.cards
      .filter((card) => card.selected && permittedCard(chat, card, run))
      .map(compactCard)
      .slice(-12),
    researchPlan: chat.researchPlan || null,
    report:
      run.mode === "revision"
        ? report
        : report && { title: report.title, version: report.version },
    revisionTarget:
      run.mode === "revision"
        ? { sectionId: run.sectionId, baseVersion: run.baseReportVersion }
        : undefined,
  };
  return {
    history,
    projectMemory,
    documentSourceIds: [...documentSourceIds(chat)],
  };
}

/** Assembler calls this short-term provider with a run snapshot; it does not infer or persist. */
export class SessionMemoryProvider {
  constructor({
    loadSession,
    run,
    clock = () => new Date().toISOString().slice(0, 10),
  }) {
    this.loadSession = loadSession;
    this.run = structuredClone(run);
    this.clock = clock;
  }
  /** Return detached, scope-filtered conversation recall; never perform cross-session retrieval. */
  async retrieve(state) {
    const chat = await this.loadSession(state.sessionId);
    return sessionContext(chat, this.run, this.clock());
  }
}
