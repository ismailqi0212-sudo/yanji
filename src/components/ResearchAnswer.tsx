import { useState, type ReactNode } from "react";
import { Check, Plus, PencilSimple } from "@phosphor-icons/react";
import type { Card } from "../types";
import Markdown from "./Markdown";

/** Reading surface and saved artifacts share IDs, not presentation wrappers. */
export default function ResearchAnswer({
  text,
  cards,
  onSource,
  onChange,
  renderCard,
  onAsk,
}: {
  text: string;
  cards: Card[];
  onSource: (id: string) => void;
  onChange: (card: Card, changes: any) => Promise<void>;
  renderCard: (card: Card) => ReactNode;
  onAsk: (question: string) => void;
}) {
  const [error, setError] = useState("");
  const sections = cards.filter((c) => c.kind === "brief");
  const lastWorksheet = cards.filter((c) => c.kind === "worksheet").at(-1)?.id;
  const visuals = cards.filter(
    (c) =>
      ["market", "chart", "scenario", "revision"].includes(c.kind) &&
      (c.kind !== "worksheet" || c.id === lastWorksheet),
  );
  const working = cards.filter((c) =>
    ["documentAnalysis", "financials", "filings"].includes(c.kind),
  );
  const gaps = cards
    .filter((c) => c.kind === "gaps")
    .flatMap((c) => c.data.items || []);
  const questions = [
    ...new Set(sections.flatMap((c) => c.data.nextQuestions || [])),
  ].slice(0, 3) as string[];
  async function select(c: Card) {
    try {
      setError("");
      await onChange(c, { selected: !c.selected });
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <div className="research-answer">
      {text && (
        <div className="answer-lead">
          <Markdown text={text} onSource={onSource} />
        </div>
      )}
      {cards
        .filter((c) => c.kind === "worksheet" && c.id === lastWorksheet)
        .map(renderCard)}
      {sections.map((c) => (
        <section className="answer-section" key={c.id}>
          <header>
            <h3>{c.title}</h3>
            <div className="section-actions">
              <button
                className={c.selected ? "is-selected" : ""}
                aria-label={
                  (c.selected ? "移出研报：" : "选入研报：") + c.title
                }
                title={c.selected ? "已选入研报" : "选入研报"}
                onClick={() => select(c)}
              >
                {c.selected ? <Check size={14} /> : <Plus size={14} />}
                <span>{c.selected ? "已选入" : "选入研报"}</span>
              </button>
            </div>
          </header>
          <Markdown text={c.data.body || ""} onSource={onSource} />
          <details className="section-edit">
            <summary>
              <PencilSimple size={12} />
              编辑这段分析
            </summary>
            {renderCard(c)}
          </details>
        </section>
      ))}
      {visuals.length > 0 && (
        <div className="answer-visuals">{visuals.map(renderCard)}</div>
      )}
      {gaps.length > 0 && (
        <details className="answer-gaps">
          <summary>尚待核实 · {gaps.length}</summary>
          <ul>
            {gaps.map((g: any, i: number) => (
              <li key={i}>
                {typeof g === "string" ? g : g.question || g.note}
              </li>
            ))}
          </ul>
        </details>
      )}
      {working.length > 0 && (
        <details className="answer-working">
          <summary>查看研究底稿 · {working.length} 项</summary>
          <p className="muted small">
            阅读记录与数据表保留在这里，点击正文数字可直接核对原文。
          </p>
          <div className="message-cards">{working.map(renderCard)}</div>
        </details>
      )}
      {questions.length > 0 && (
        <div className="answer-followups">
          {questions.map((q) => (
            <button key={q} onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      {error && <p className="inline-error">{error}</p>}
    </div>
  );
}
