import type { Run } from "../types";
const labels = ["理解问题", "检索与取数", "核对与交付"];
export default function AgentProgress({ run }: { run: Run }) {
  const active =
    run.status === "completed"
      ? 3
      : run.stage === "checking"
        ? 2
        : run.stage === "researching"
          ? 1
          : 0;
  return (
    <details className="agent-process" open={run.status === "running"}>
      <summary>
        {run.status === "running" ? "正在研究" : "研究过程"}
        {run.round ? ` · ${run.round} 轮` : ""}
      </summary>
      <div className="process-steps">
        {labels.map((label, i) => (
          <span
            key={label}
            className={
              i < active
                ? "done"
                : i === active && run.status === "running"
                  ? "current"
                  : ""
            }
          >
            <i>{i < active ? "✓" : i + 1}</i>
            {label}
          </span>
        ))}
        <small>
          {run.round
            ? run.round + " 轮"
            : run.status === "running"
              ? "准备中"
              : "历史记录"}
        </small>
      </div>
      {run.documentProgress && (
        <div className="document-progress">
          {run.documentProgress.map((d) => (
            <div key={d.id}>
              <span>{d.name}</span>
              <small>
                {d.status === "completed"
                  ? d.cached
                    ? "已读取底稿"
                    : "阅读完成"
                  : d.status === "reading"
                    ? `阅读第 ${d.completedParts || 0} / ${d.parts} 批`
                    : "等待阅读"}
              </small>
            </div>
          ))}
        </div>
      )}
      <details className="run-details">
        <summary>
          {run.mode === "revision" ? "补查过程" : "研究过程"} ·{" "}
          {run.events.length} 项记录
        </summary>
        {run.plan && (
          <div className="run-plan">
            <strong>{run.plan.goal}</strong>
            <ol>
              {run.plan.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        )}
        {run.events.map((event, i) => (
          <p key={i}>
            <span>{event.label}</span>
            {event.detail}
          </p>
        ))}
        {run.memory && (
          <div className="memory-summary">
            工作记忆：{run.memory.observedSources} 个已读来源 ·{" "}
            {run.memory.retainedMessages} 条模型上下文 · 检查点第{" "}
            {run.memory.round}{" "}
            轮。历史原文与完整工具结果保存在本项目，不跨项目调用。
          </div>
        )}
      </details>
    </details>
  );
}
