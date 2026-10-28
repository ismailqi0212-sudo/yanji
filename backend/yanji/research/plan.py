"""研究笔记中的缺口是待验证问题，不把模型推断写成已证实事实。"""

from ..common import AppError, now, uid, unique
from ..tools.documents import evidence


def remember_gaps(chat, run, questions):
    if not chat.get("researchPlan"):
        chat["researchPlan"] = dict(
            goal=run["question"], steps=[], gaps=[], runId=run["id"], at=now()
        )
    plan = chat["researchPlan"]
    for item in questions:
        question = item.get("question") if isinstance(item, dict) else str(item)
        dimension = (
            item.get("dimension", "deep_dive")
            if isinstance(item, dict)
            else "deep_dive"
        )
        if (
            not question
            or not question.strip()
            or any(g["question"] == question for g in plan["gaps"])
        ):
            continue
        plan["gaps"].append(
            dict(
                id=uid(),
                question=question[:600],
                dimension=dimension
                if dimension in ("temporal", "comparison", "deep_dive", "market")
                else "deep_dive",
                status="open",
                note="",
                sourceIds=[],
                at=now(),
            )
        )
    plan["gaps"] = plan["gaps"][-24:]


def save_plan(args, context):
    chat = context["workspace"].chat
    run = context["run"]
    if (
        not str(args.get("goal", "")).strip()
        or not isinstance(args.get("steps"), list)
        or not 1 <= len(args["steps"]) <= 6
    ):
        raise AppError("研究计划需目标和1至6个步骤")
    chat["researchPlan"] = dict(
        goal=str(args["goal"])[:600],
        steps=list(map(str, args["steps"])),
        at=now(),
        runId=run["id"],
        gaps=(chat.get("researchPlan") or {}).get("gaps", []),
    )
    remember_gaps(chat, run, args.get("gaps", [])[:8])
    next(r for r in chat["runs"] if r["id"] == run["id"])["plan"] = {
        k: chat["researchPlan"][k] for k in ("goal", "steps")
    }
    return chat["researchPlan"]


def update_gap(args, context):
    chat = context["workspace"].chat
    gap = next(
        (
            g
            for g in (chat.get("researchPlan") or {}).get("gaps", [])
            if g["id"] == args["gapId"]
        ),
        None,
    )
    if not gap:
        raise AppError("缺口不存在，请读取当前研究记忆")
    ids = unique(args.get("sourceIds", []))
    if any(s not in context["seen"] or not evidence(chat, s) for s in ids):
        raise AppError("缺口依据必须已读取且属于本项目")
    if args["status"] == "answered" and not ids:
        raise AppError("没有来源不能标为已补充依据")
    gap.update(
        status=args["status"],
        note=str(args.get("note", ""))[:1500],
        sourceIds=ids,
        updatedAt=now(),
    )
    return gap
