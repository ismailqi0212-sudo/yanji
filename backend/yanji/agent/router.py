"""透明的规则路由：决定任务重点与资料权限，不代替模型选择每个工具。"""

import json
import re
from ..common import AppError
from ..context.assembler import ROOT

SKILLS = json.loads((ROOT / "shared/research-skills.json").read_text())


def get_skill(skill_id):
    if not skill_id:
        return None
    skill = next((s for s in SKILLS if s["id"] == skill_id), None)
    if not skill:
        raise AppError("不支持的研究任务")
    # 白名单ID映射到仓库自有文件，上传文档不能成为系统Skill。
    return {
        **skill,
        "instructions": (
            ROOT / "backend/yanji/skills" / skill_id / "SKILL.md"
        ).read_text(),
    }


def resolve_source_policy(chat, question, options=None):
    options = options or {}
    has_documents = bool(chat["documents"])
    text = re.sub(r"\s+", "", str(question))
    positive = re.sub(
        r"(?:不要|不用|无需|不必|不需要)(?:再|额外|另外)?(?:查询|查找|搜索|搜集|检索|使用|用)?(?:外部(?:数据|信息|资料|来源)?|网络(?:数据|信息)?|公开数据|上网|联网|搜索|搜集|检索)",
        "",
        text,
    )
    report_only = re.search(
        r"(?:仅|只)(?:依据|根据|按照|按|使用|用|看|从|基于)[^，。；;]{0,16}(?:报告|财报|年报|季报|材料|附件|文档)",
        text,
    ) or re.search(
        r"(?:不要|不用|无需|不必|不需要)(?:再|额外|另外)?(?:查询|查找|搜索|搜集|检索|使用|用)?(?:外部|网络|公开数据|上网|联网)",
        text,
    )
    external_only = re.search(
        r"(?:仅|只)(?:查|用|搜索|看|从|根据|使用)[^，。；;]{0,10}(?:公开|网络|外部|联网|网上)",
        positive,
    ) or re.search(
        r"(?:不使用|不用|忽略|不要用)[^，。；;]{0,8}(?:上传|附件|报告|财报|材料)", text
    )
    asks_for_report = re.search(
        r"(?:按照|根据|依据|基于)(?:我|本对话|已上传|上传|这些|这几份|附件|上述|提供的)?的?(?:报告|财报|年报|材料|附件)",
        text,
    )
    if (asks_for_report or report_only) and not has_documents and not external_only:
        raise AppError("你要求依据报告，但本对话还没有报告，请先上传材料")
    if report_only and not external_only:
        return dict(
            sourceMode="documents", sourceReason="用户要求依据报告或不使用外部信息"
        )
    if external_only:
        return dict(sourceMode="external", sourceReason="用户明确只使用外部信息")
    if options.get("sourceMode") in ("documents", "hybrid", "external"):
        return dict(
            sourceMode=options["sourceMode"], sourceReason="调用方明确指定资料范围"
        )
    local = re.search(
        r"(?:搜索|检索|查找|搜一下|搜集|收集)(?:本对话|已上传|上传|这些|这几份|这份)?(?:报告|财报|年报|附件|文档|材料)(?:中|里|内|的)?",
        positive,
    )
    outside = re.search(
        r"搜集|上网|联网|公开数据|外部(?:信息|资料|数据)|(?:搜索|搜一下|查找|检索)(?!报告|财报|年报|附件|文档|材料)|最新(?:股价|行情|公告)|实时(?:股价|行情)|今日股价|当前(?:股价|估值)",
        positive,
    )
    if (
        has_documents
        and outside
        and (
            not local
            or re.search(r"联网|上网|外部|公开数据|最新(?:股价|行情|公告)", positive)
        )
    ):
        return dict(
            sourceMode="hybrid", sourceReason="已上传报告，并明确请求补充外部信息"
        )
    return dict(
        sourceMode="documents" if has_documents else "external",
        sourceReason="默认优先使用当前对话的报告"
        if has_documents
        else "本对话没有材料，使用可用的公开数据工具",
    )


def route_task(chat, question, options=None):
    options = options or {}
    skill = get_skill(options.get("skillId"))
    if skill and skill["requiresDocuments"] and not chat["documents"]:
        raise AppError("这个任务需要财报材料，请先上传报告再开始")
    policy = resolve_source_policy(chat, question, options)
    if (
        skill
        and skill["id"] == "operating-metrics"
        and policy["sourceMode"] == "external"
    ):
        raise AppError(
            "经营数据底稿需要读取上传报告；如需外部信息，可直接提问或选择财务体检"
        )
    positive = re.sub(
        r"(?:不需要|无需|不要|不用|不必)(?:新增|生成|制作|绘制|做)?(?:任何)?(?:图表|折线图|柱状图|画图|测算|情景|沙盘)",
        "",
        question,
    )
    intents = [
        (
            "scenario",
            r"假设|情景|沙盘|测算|敏感性",
            "围绕用户变量做情景分析，先确认基准数据，明确区分假设和已披露事实。",
        ),
        (
            "chart",
            r"图表|折线|柱状|走势图|变化图|画图|绘图",
            "优先交付用户指定指标的图表；简要解释趋势和口径，不扩写无关研究。",
        ),
        (
            "research",
            r"为什么|原因|分析|研究|比较|对比|质量|驱动|逻辑|风险|研报",
            "先回答核心问题，再用证据展开推导；必要时补查反向证据，不机械套用四段模板。",
        ),
        (
            "lookup",
            r"股价|行情|市盈率|估值|收入|利润|毛利|财务|多少|查询|查看",
            "直接回答所查指标、期间和单位；简单查询不扩写多条长发现。",
        ),
    ]
    match = next((i for i in intents if re.search(i[1], positive)), intents[2])
    count = re.search(
        r"([1-5一二两三四五])\s*(?:段|条)(?:自然)?(?:分析|发现|结论)?", positive
    )
    count = (
        {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5}.get(
            count[1], int(count[1]) if count[1].isdigit() else 5
        )
        if count
        else 5
    )
    revision = options.get("mode") == "revision"
    return {
        **policy,
        "skillId": skill["id"] if skill else None,
        "skillName": skill["name"] if skill else None,
        "maxFindings": 1 if skill and skill["id"] == "operating-metrics" else count,
        "intent": "revision" if revision else match[0],
        "instruction": "先读取目标章节，再补查并提交待确认修订，不能直接覆盖。"
        if revision
        else match[2],
        "reason": "用户指定章节修订" if revision else "按问题关键词选择交付侧重点",
        "maxSteps": 9,
        "maxToolCalls": 32,
        "timeoutMs": 420000 if policy["sourceMode"] == "external" else 900000,
    }
