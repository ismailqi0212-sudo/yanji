/** Deterministic report reviewer, not a second LLM pretending to establish truth. */
import { refs } from "../tools/documents/documents.mjs";
import { validateAnswer } from "../research/validation.mjs";
export function reviewDraft(chat, draft, sourceIds, calculations) {
  if (!draft.sections?.length) throw new Error("报告缺少有效章节");
  let citations = 0,
    numericSections = 0;
  const titles = new Set();
  for (const section of draft.sections) {
    if (
      typeof section.content !== "string" ||
      typeof section.title !== "string" ||
      !section.content.trim()
    )
      throw new Error("章节缺少正文");
    if (titles.has(section.title))
      throw new Error("章节标题重复，请合并重复内容");
    titles.add(section.title);
    section.content = section.content.replace(
      /（[^）\n]*稍后由程序插入。?）/g,
      "",
    );
    const used = refs(section.content);
    citations += used.length;
    for (const sourceId of used)
      if (!sourceIds.includes(sourceId))
        throw new Error("稿件包含未确认来源，已拒绝写入");
    const sectionText = section.title + "\n" + section.content;
    if (/[\d][\d,.]*\s*(?:[%％]|个?百分点)/.test(sectionText)) {
      numericSections++;
      if (!used.length) throw new Error("含百分比的章节必须附上对应底稿来源");
    }
    if (used.length)
      validateAnswer(
        chat,
        { answer: sectionText, sourceIds },
        new Set(sourceIds),
        calculations,
      );
  }
  return {
    kind: "deterministic",
    checkedAt: new Date().toISOString(),
    sourceCount: sourceIds.length,
    citations,
    numericSections,
    checks: ["引用属于本次确认材料", "百分比与计算口径", "章节完整与去重"],
    limits: "不代表因果解释、全部金额或投资判断已被证明；仍需对照原文审阅。",
  };
}
