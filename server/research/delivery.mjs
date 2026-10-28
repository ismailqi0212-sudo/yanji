import { toolEffects } from "./effects.mjs";
/** Validate every finding before persisting any publishable research section. */
import { makeCard } from "./artifacts.mjs";
import { rememberGaps } from "./plan.mjs";
import { validateAnswer } from "./validation.mjs";
import { refs } from "../tools/documents/documents.mjs";
export function deliverResearch({ cid, run, seen, calculations, effects }, a) {
  const { getProject, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  const limit = run.route?.maxFindings || 5;
  if (!Array.isArray(a.findings) || a.findings.length > limit)
    throw new Error(
      `请按本轮要求提供最多${limit}段分析；合并重复解释，将资料缺口放入gaps。`,
    );
  const checked = a.findings.map((f) => {
    if (!f.title || !f.body) throw new Error("发现需要标题和正文");
    const resolve = (eid) =>
      calculations.find((x) => x.id === eid)?.sourceIds || [eid];
    const sourceIds = [...new Set((f.sourceIds || []).flatMap(resolve))];
    const normalized = f.body.replace(
      /evidence:(C\d+)\b/g,
      (_, cid) => "evidence:" + resolve(cid)[0],
    );
    const cited = refs(normalized).length
      ? normalized
      : normalized +
        " " +
        sourceIds.map((eid, j) => `[依据${j + 1}](evidence:${eid})`).join(" ");
    const valid = validateAnswer(
      c,
      { answer: cited, sourceIds },
      seen,
      calculations,
    );
    return { ...f, body: valid.answer, sourceIds: valid.sourceIds };
  });
  if (!checked.length && !a.gaps?.length)
    throw new Error("至少提供一条发现或明确缺口");
  for (const f of checked)
    addArtifact(
      cid,
      run.id,
      makeCard(
        "brief",
        f.title,
        {
          body: f.body,
          kind: f.kind,
          notes: "",
          gaps: [],
          nextQuestions: Array.isArray(f.nextQuestions)
            ? f.nextQuestions.filter((x) => typeof x === "string").slice(0, 2)
            : [],
        },
        f.sourceIds,
      ),
    );
  if (a.gaps?.length) rememberGaps(cid, run.id, a.gaps, effects);
  if (a.gaps?.length)
    addArtifact(
      cid,
      run.id,
      makeCard("gaps", "还需要核实", { items: a.gaps }, []),
    );
  return {
    done: true,
    summary: String(a.summary || "研究结果已整理。"),
  };
}
