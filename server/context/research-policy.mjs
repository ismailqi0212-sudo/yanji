import { RESEARCH_PROMPT } from "../agent/prompts/research.mjs";
import { getResearchSkill } from "../skills/catalog.mjs";
/** ContextAssembler calls this trusted policy factory; it does not read model/user content as instructions. */
export function researchPolicy(run) {
  return (
    RESEARCH_PROMPT +
    (run.route.skillId
      ? "\n已选任务Skill：\n" + getResearchSkill(run.route.skillId).instructions
      : "") +
    "\n资料路由：" +
    run.route.sourceReason +
    "。仅报告模式禁止外部取数；混合模式先用报告，再按用户需求补充可用外部来源，分清披露期与查询时间。没有通用网页搜索工具，不冒称已搜索新闻或全网资料。" +
    "\n本轮任务侧重点：" +
    run.route.instruction +
    (run.sourceMode !== "external" && run.route.skillId !== "operating-metrics"
      ? "\n本轮以用户上传报告为主线，先用当前前置工具长文阅读全部材料。研究期间以文件实际覆盖的年度为准，不用外部更新年份替代。直接使用分析返回的原文sourceId和metrics；需要收入/毛利率趋势就调用chartFromFilings，并把研究发现引用到PDF原文。资料不覆盖的年份明确说明。"
      : "") +
    (run.mode === "revision"
      ? "\n本轮任务是补查并修订指定研报章节。先读取章节、识别缺口，必要时检索材料或查询财务；最后调用proposeReportRevision生成待确认修改，不能直接覆盖报告。缺乏证据时收敛原判断并写明缺口。"
      : "")
  );
}
