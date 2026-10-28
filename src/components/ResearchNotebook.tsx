import type { Chat } from "../types";
const dimensions: Record<string, string> = {
  temporal: "时效更新",
  comparison: "同行对比",
  deep_dive: "深入分析",
  market: "市场视角",
};
export default function ResearchNotebook({
  chat,
  onAsk,
  onSource,
}: {
  chat: Chat | null;
  onAsk: (question: string) => void;
  onSource: (id: string) => void;
}) {
  const plan = chat?.researchPlan;
  if (!plan)
    return (
      <div className="panel-empty">
        <h3>还没有研究计划</h3>
        <p>提出研究问题后，Agent 可记录研究目标、步骤和缺口。</p>
      </div>
    );
  return (
    <div className="research-notebook">
      <p className="eyebrow">研究目标</p>
      <h2>{plan.goal}</h2>
      {plan.steps.length > 0 && (
        <ol>
          {plan.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      <h3>需要补充的证据</h3>
      {Object.entries(dimensions).map(([key, label]) => {
        const gaps = plan.gaps.filter((g) => g.dimension === key);
        return (
          gaps.length > 0 && (
            <section key={key}>
              <h4>{label}</h4>
              {gaps.map((g) => (
                <article key={g.id}>
                  <span className={"gap-status " + g.status}>
                    {
                      {
                        open: "待补查",
                        blocked: "资料不足",
                        answered: "已补充依据",
                      }[g.status]
                    }
                  </span>
                  <p>{g.question}</p>
                  {g.note && <small>{g.note}</small>}
                  <div>
                    {g.sourceIds.map((s, i) => (
                      <button key={s} onClick={() => onSource(s)}>
                        依据 {i + 1}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        onAsk(
                          "补查研究缺口（ID：" +
                            g.id +
                            "）：" +
                            g.question +
                            "。请先核对本项目材料及可用财务数据，并用updateResearchGap保存依据；没有原文就保留缺口。",
                        )
                      }
                    >
                      补查这个问题 ↗
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )
        );
      })}
      {!plan.gaps.length && <p className="muted">当前未记录资料缺口。</p>}
    </div>
  );
}
