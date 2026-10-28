import ReactMarkdown from "react-markdown";
export default function Markdown({
  text,
  onSource,
}: {
  text: string;
  onSource: (id: string) => void;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        urlTransform={(u) =>
          u.startsWith("evidence:") ? u : /^https?:/.test(u) ? u : ""
        }
        components={{
          a: ({ href, children }) =>
            href?.startsWith("evidence:") ? (
              <button
                className={
                  "source-cite" +
                  (/^(依据|来源)\s*\d+$/.test(String(children))
                    ? " citation-note"
                    : "")
                }
                title="查看原文依据"
                aria-label={"查看原文：" + String(children)}
                onClick={() => onSource(href.slice(9))}
              >
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
