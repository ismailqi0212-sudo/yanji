import { toolEffects } from "../research/effects.mjs";
export { readReportTool, revisionTool } from "../tools/task-schemas.mjs";
import { rememberGaps } from "../research/plan.mjs";
/** Proposals are evidence-bound artifacts. Only an explicit accept action writes a new report version. */
import { getProject, putProject, now } from "../memory/store.mjs";
import { addArtifact, event } from "../memory/run-state.mjs";
import { makeCard } from "../research/artifacts.mjs";
import { validateAnswer } from "../research/validation.mjs";
import { reportComputations } from "./computations.mjs";
import { refs, evidence } from "../tools/documents/documents.mjs";
export function readCurrentReport(cid, effects) {
  const { getProject } = toolEffects(effects);
  const c = getProject(cid);
  if (!c.report) throw new Error("尚无研报");
  return {
    title: c.report.title,
    version: c.report.version,
    sections: c.report.sections,
    sourceIds: c.report.sourceIds,
  };
}
export function proposeRevision(
  { cid, run, seen, calculations, effects },
  args,
) {
  const { getProject, addArtifact, event } = toolEffects(effects);
  const c = getProject(cid),
    report = c.report;
  if (!report || report.version !== run.baseReportVersion)
    throw new Error("研报版本已变化，请基于最新章节重新发起补查");
  if (args.sectionId !== run.sectionId) throw new Error("只能修改本次指定章节");
  const section = report.sections.find((s) => s.id === args.sectionId);
  if (!section) throw new Error("章节不存在");
  const sourceIds = [
    ...new Set([...(args.sourceIds || []), ...refs(args.content || "")]),
  ];
  if (!sourceIds.length) throw new Error("修改建议必须关联已读取的证据");
  const cited = refs(args.content || "").length
    ? args.content
    : args.content +
      "\n\n" +
      sourceIds.map((s, i) => `[依据${i + 1}](evidence:${s})`).join(" ");
  const valid = validateAnswer(c, { answer: cited, sourceIds }, seen, [
    ...calculations,
    ...reportComputations(
      c,
      c.cards.filter((card) =>
        card.sourceIds.some((sid) => sourceIds.includes(sid)),
      ),
      sourceIds,
    ),
  ]);
  const proposal = makeCard(
    "revision",
    "章节修改建议 · " + section.title,
    {
      sectionId: section.id,
      sectionTitle: args.title || section.title,
      baseVersion: report.version,
      before: section.content,
      body: valid.answer,
      reason: String(args.reason || ""),
      remainingGaps: Array.isArray(args.remainingGaps)
        ? args.remainingGaps
        : [],
      status: "pending",
      dependencyVersions: Object.fromEntries(
        c.cards
          .filter((card) => card.sourceIds.some((id) => sourceIds.includes(id)))
          .map((card) => [card.id, card.version]),
      ),
    },
    valid.sourceIds,
  );
  rememberGaps(
    cid,
    run.id,
    Array.isArray(args.remainingGaps) ? args.remainingGaps : [],
    effects,
  );
  addArtifact(cid, run.id, proposal);
  event(cid, run.id, "已生成章节修改", "原稿未覆盖，等待用户确认");
  return {
    done: true,
    cardId: proposal.id,
    summary:
      "补查完成，已生成章节修改建议。请核对新增证据和前后内容，确认后写入研报。",
  };
}
export function acceptRevision(cid, cardId) {
  const c = getProject(cid),
    card = c.cards.find((card) => card.id === cardId);
  if (card?.kind !== "revision" || card.data.status !== "pending")
    throw new Error("该修改建议不在待确认状态");
  const report = c.report;
  if (!report || report.version !== card.data.baseVersion)
    throw Object.assign(new Error("报告已有新版本，请重新补查生成建议"), {
      status: 409,
    });
  for (const [id, version] of Object.entries(
    card.data.dependencyVersions || {},
  ))
    if (c.cards.find((card) => card.id === id)?.version !== version)
      throw Object.assign(new Error("引用底稿已变化，请重新补查"), {
        status: 409,
      });
  for (const sid of card.sourceIds)
    if (!evidence(c, sid)) throw new Error("修改建议的来源已失效");
  const section = report.sections.find(
    (section) => section.id === card.data.sectionId,
  );
  if (!section) throw new Error("章节不存在");
  c.reports.push(structuredClone(report));
  section.title = card.data.sectionTitle;
  section.content = card.data.body;
  report.sourceIds = [...new Set([...report.sourceIds, ...card.sourceIds])];
  report.version++;
  report.at = now();
  // Confirmation also confirms the new evidence used by this paragraph; other draft cards remain unselected.
  for (const sourceCard of c.cards.filter(
    (item) =>
      item.kind !== "revision" &&
      item.sourceIds.some((s) => card.sourceIds.includes(s)),
  )) {
    sourceCard.selected = true;
    report.cardVersions[sourceCard.id] = sourceCard.version;
    if (["chart", "financials", "scenario"].includes(sourceCard.kind)) {
      report.artifacts = report.artifacts.filter(
        (old) => old.id !== sourceCard.id,
      );
      report.artifacts.push(structuredClone(sourceCard));
    }
  }
  // Preserve a pre-existing stale flag: changing one paragraph cannot validate every other section.
  card.data.status = "accepted";
  card.data.acceptedVersion = report.version;
  card.version++;
  c.revision++;
  putProject(c);
  return c;
}
