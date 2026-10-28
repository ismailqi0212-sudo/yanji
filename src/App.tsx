import researchSkills from "../shared/research-skills.json";
import {
  Table,
  ChartLine,
  FirstAidKit,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import ResearchAnswer from "./components/ResearchAnswer";
import AgentProgress from "./components/AgentProgress";
import EvidencePanel from "./components/EvidencePanel";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Button,
  Input,
  Textarea,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Spinner,
  Tooltip,
} from "@heroui/react";
import {
  Plus,
  MagnifyingGlass,
  GearSix,
  ArrowUp,
  Paperclip,
  SidebarSimple,
  FileText,
  X,
  Stop,
  ArrowSquareOut,
  DownloadSimple,
  Check,
  CheckSquare,
  ClockCounterClockwise,
  ChatCircleDots,
  ArrowLeft,
  Stack,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "./api";
import type { Chat, Summary, Source, Card } from "./types";
import ResearchCard, { FinancialTable } from "./components/Cards";
import Markdown from "./components/Markdown";
export default function App() {
  const [list, setList] = useState<Summary[]>([]),
    [cid, setCid] = useState(location.hash.slice(1)),
    [chat, setChat] = useState<Chat | null>(null),
    [question, setQuestion] = useState(""),
    [settings, setSettings] = useState<any>({ hasKey: false }),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 700),
    [panel, setPanel] = useState(""),
    [view, setView] = useState("chat"),
    [activeSkill, setActiveSkill] = useState(""),
    [evidenceOpen, setEvidenceOpen] = useState(false),
    [modal, setModal] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [compiling, setCompiling] = useState(false),
    [reportFormat, setReportFormat] = useState("full"),
    [source, setSource] = useState<Source | null>(null),
    [form, setForm] = useState({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      key: "",
    }),
    [editVersion, setEditVersion] = useState(0),
    [editing, setEditing] = useState(""),
    [editText, setEditText] = useState(""),
    [search, setSearch] = useState(""),
    [showArchived, setShowArchived] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    chatRef = useRef<Chat | null>(null),
    listTime = useRef(0);
  const running = chat?.runs.find((r) => r.status === "running"),
    selected = chat?.cards.filter((c) => c.selected) || [],
    report = chat?.report,
    reportBusy = compiling || chat?.reportJob?.status === "running";
  const listChats = useCallback(async () => {
    const rows = await api<Summary[]>("/chats?includeArchived=1");
    setList(rows);
  }, []);
  const update = (c: Chat) => {
    chatRef.current = c;
    setChat(c);
  };
  useEffect(() => {
    listChats().catch((e) => setError(e.message));
    api("/settings")
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, [listChats]);
  useEffect(() => {
    history.replaceState(null, "", cid ? "#" + cid : location.pathname);
    if (!cid) {
      update(null as any);
      return;
    }
    setPanel("");
    setEvidenceOpen(false);
    setSource(null);
    if (chatRef.current?.id !== cid) update(null as any);
    let live = true;
    api<Chat>("/chats/" + cid)
      .then((c) => live && update(c))
      .catch((e) => setError(e.message));
    const events = new EventSource("/api/chats/" + cid + "/events");
    events.onmessage = (e) => {
      if (!live) return;
      const c = JSON.parse(e.data);
      if (c.reportJob?.status === "completed" &&
          chatRef.current?.reportJob?.status === "running") setError("");
      update(c);
      if (Date.now() - listTime.current > 2000) {
        listTime.current = Date.now();
        listChats();
      }
    };
    events.onerror = () => {};
    return () => {
      live = false;
      events.close();
    };
  }, [cid, listChats]);
  useEffect(() => {
    const listener = () => {
      setCid(location.hash.slice(1));
      setPanel("");
    };
    addEventListener("hashchange", listener);
    return () => removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    if (question) return;
    bottom.current?.scrollIntoView({
      behavior: running ? "auto" : "smooth",
      block: "end",
    });
  }, [chat?.messages.length, chat?.cards.length]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function ensureChat() {
    if (chatRef.current) return chatRef.current;
    const c = await api<Chat>("/chats", "POST");
    update(c);
    setCid(c.id);
    await listChats();
    return c;
  }
  async function send(text = question) {
    if (activeSkill === "operating-metrics")
      text = text.trim()
        ? "整理本对话财报的经营数据底稿，关注指标：" + text
        : "整理本对话财报的经营数据底稿，优先提取多期重复披露的业务指标，保留口径与缺失。";
    if (!text.trim() || running || busy) return;
    if (/【公司名称或证券代码】/.test(text)) {
      setError("请先把提示词中的公司名称或证券代码填写好");
      return;
    }
    if (
      researchSkills.find((s) => s.id === activeSkill)?.requiresDocuments &&
      !chat?.documents.length
    ) {
      setError("请先上传财报材料，再运行这个任务");
      return;
    }
    await act(async () => {
      const c = await ensureChat();
      await api(`/chats/${c.id}/messages`, "POST", {
        text,
        skillId: activeSkill || undefined,
      });
      setQuestion("");
      setActiveSkill("");
      update(await api("/chats/" + c.id));
      await listChats();
    });
  }
  async function sourceOpen(eid: string) {
    if (!cid) return;
    try {
      setSource(await api(`/chats/${cid}/sources/${encodeURIComponent(eid)}`));
      setEvidenceOpen(true);
      if (view === "chat") setPanel("");
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function documentOpen(documentId: string, page = 1) {
    if (!cid) return;
    try {
      setSource(
        await api(`/chats/${cid}/documents/${documentId}/page/${page}`),
      );
      setEvidenceOpen(true);
      if (view === "chat") setPanel("");
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function cardChange(card: Card, changes: any) {
    const c = chatRef.current;
    if (!c) return;
    try {
      update(
        await api(`/chats/${c.id}/cards/${card.id}`, "PATCH", {
          revision: c.revision,
          ...changes,
        }),
      );
    } catch (e: any) {
      update(await api("/chats/" + c.id));
      throw e;
    }
  }
  async function composeFromWorksheet(card: Card) {
    await act(async () => {
      if (!card.selected) await cardChange(card, { selected: true });
      setReportFormat("brief");
      setView("chat");
      setEvidenceOpen(false);
      setPanel("selected");
    });
  }
  async function createChart(card: Card, metric: string) {
    await act(async () => {
      const c = chatRef.current!;
      update(
        await api(`/chats/${c.id}/cards/${card.id}/chart`, "POST", {
          revision: c.revision,
          metric,
        }),
      );
    });
  }
  async function acceptProposal(cardId: string) {
    const c = chatRef.current;
    if (!c) return;
    update(await api(`/chats/${c.id}/revisions/${cardId}/accept`, "POST"));
    setPanel("report");
    setView("report");
  }
  async function researchSection(sectionId: string, instruction: string) {
    if (!instruction.trim()) throw new Error("请填写补查要求");
    await api(`/chats/${cid}/report/research`, "POST", {
      sectionId,
      instruction,
    });
    setEditing("");
    setPanel("");
    setView("chat");
    setEvidenceOpen(false);
    update(await api("/chats/" + cid));
  }
  async function compile() {
    if (!cid) return;
    setCompiling(true);
    setPanel("report");
    setView("report");
    setEvidenceOpen(false);
    setError("");
    try {
      update(
        await api(`/chats/${cid}/compile`, "POST", { format: reportFormat }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCompiling(false);
    }
  }
  function openSettings() {
    setForm({
      baseUrl: settings.baseUrl || "https://api.deepseek.com",
      model: settings.model || "deepseek-flash",
      key: "",
    });
    setModal("settings");
  }
  function newChat() {
    setView("chat");
    setEvidenceOpen(false);
    setCid("");
    update(null as any);
    setQuestion("");
    setActiveSkill("");
    setPanel("");
    setSource(null);
    setError("");
  }
  const cardsById = new Map(chat?.cards.map((c) => [c.id, c]));
  return (
    <div className="app-shell">
      <aside className={"app-sidebar " + (!sidebar ? "collapsed" : "")}>
        <div className="brand">
          <span className="brand-icon">
            <ChatCircleDots size={21} weight="bold" />
          </span>
          <b>研迹</b>
          <small>对话投研</small>
          <button
            className="mobile-menu-close"
            aria-label="关闭侧栏"
            onClick={() => setSidebar(false)}
          >
            <X size={16} />
          </button>
        </div>
        <Button
          className="new-chat"
          variant="bordered"
          startContent={<Plus size={16} />}
          onPress={newChat}
        >
          新研究
        </Button>
        <div className="sidebar-search">
          <MagnifyingGlass size={14} />
          <input
            aria-label="搜索研究对话"
            placeholder="搜索对话"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sidebar-label">
          {showArchived ? "已归档" : "研究记录"}
          <button
            className="archive-toggle"
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived
              ? "返回研究"
              : `已归档 ${list.filter((c) => c.archived).length}`}
          </button>
        </div>
        <nav className="chat-list">
          {list
            .filter((c) => !!c.archived === showArchived)
            .filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
            .map((c) => (
              <button
                key={c.id}
                className={cid === c.id ? "active" : ""}
                onClick={() => {
                  setCid(c.id);
                  setQuestion("");
                  setActiveSkill("");
                  setPanel("");
                  setView("chat");
                  setEvidenceOpen(false);
                  setError("");
                }}
              >
                <ChatCircleDots size={15} />
                <span>{c.title}</span>
              </button>
            ))}
          {!list.length && <p className="sidebar-empty">还没有研究对话</p>}
        </nav>
        <footer>
          <button onClick={openSettings}>
            <GearSix size={16} />
            <span>设置</span>
          </button>
        </footer>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button"
            aria-label="切换侧栏"
            onClick={() => setSidebar(!sidebar)}
          >
            <SidebarSimple size={19} />
          </button>
          <div className="conversation-title">{chat?.title || "新研究"}</div>
          <div className="view-switch">
            <button
              className={view === "chat" ? "active" : ""}
              onClick={() => {
                setView("chat");
                setPanel("");
                setEvidenceOpen(false);
              }}
            >
              研究
            </button>
            <button
              className={view === "report" ? "active" : ""}
              onClick={() => {
                setView("report");
                setPanel("report");
              }}
            >
              研报
            </button>
          </div>
          <div className="topbar-actions">
            {chat?.archived && (
              <button
                onClick={() =>
                  act(async () => {
                    update(
                      await api("/chats/" + cid, "PATCH", { archived: false }),
                    );
                    await listChats();
                    setShowArchived(false);
                  })
                }
              >
                恢复对话
              </button>
            )}

            <button
              disabled={!cid || chat?.id !== cid}
              className={panel === "materials" ? "active" : ""}
              onClick={() => setPanel(panel === "materials" ? "" : "materials")}
            >
              <Paperclip size={15} />
              材料{chat?.documents.length ? ` ${chat.documents.length}` : ""}
            </button>
            <button
              className={panel === "selected" ? "active" : ""}
              onClick={() => setPanel(panel === "selected" ? "" : "selected")}
            >
              <Stack size={15} />
              已选{selected.length ? ` ${selected.length}` : ""}
            </button>
            <button
              className={
                "mobile-report-button " + (panel === "report" ? "active" : "")
              }
              onClick={() => {
                setPanel("report");
                setView("report");
              }}
            >
              <FileText size={15} />
              研报{report && <i />}
            </button>
          </div>
        </header>
        {error && (
          <div className="error-toast" role="alert">
            <WarningCircle size={16} />
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={14} />
            </button>
          </div>
        )}
        <div
          className={
            "workspace-body " +
            (view === "report" && panel === "report"
              ? "report-focus" + (evidenceOpen ? " report-split" : "")
              : "")
          }
        >
          <main
            className={
              "conversation" + (!chat?.messages.length ? " is-empty" : "")
            }
          >
            <div className="conversation-scroll">
              {!chat?.messages.length ? (
                <div className="chat-empty">
                  <h1>开始一项研究</h1>
                </div>
              ) : (
                <div className="transcript">
                  {chat.messages.map((m) => {
                    const run = chat.runs.find((r) => r.messageId === m.id);
                    return (
                      <section
                        className={"message message-" + m.role}
                        key={m.id}
                      >
                        {m.role === "user" ? (
                          <div className="user-bubble">{m.text}</div>
                        ) : (
                          <>
                            <div className="assistant-label">
                              <span className="assistant-mark">
                                <MagnifyingGlass size={13} />
                              </span>
                              <b>研迹</b>
                              <span>
                                {run?.status === "running" ? "正在研究" : ""}
                              </span>
                            </div>
                            <ResearchAnswer
                              text={m.text}
                              cards={m.cardIds
                                .map((id) => cardsById.get(id))
                                .filter((c): c is Card => !!c)}
                              onSource={sourceOpen}
                              onChange={cardChange}
                              onAsk={(q) => send(q)}
                              renderCard={(card) => (
                                <ResearchCard
                                  inlineSources
                                  key={card.id}
                                  card={card}
                                  onChange={(changes) =>
                                    cardChange(card, changes)
                                  }
                                  onSource={sourceOpen}
                                  onChart={(metric) =>
                                    createChart(card, metric)
                                  }
                                  onAsk={(q) => send(q)}
                                  onAccept={acceptProposal}
                                  onDocument={documentOpen}
                                  onCompose={() => composeFromWorksheet(card)}
                                />
                              )}
                            />
                            {run?.status === "running" && (
                              <div className="agent-working">
                                <Spinner size="sm" color="default" />
                                <span>
                                  {run.events.at(-1)?.label || "正在准备"}
                                </span>
                                {run.liveText && <p>{run.liveText}</p>}
                              </div>
                            )}
                            {run?.error && (
                              <p className="inline-error">{run.error}</p>
                            )}
                            {run && <AgentProgress run={run} />}
                          </>
                        )}
                      </section>
                    );
                  })}
                  <div ref={bottom} />
                </div>
              )}
            </div>
            <div className="composer-area">
              <div className="research-skills" aria-label="研究任务">
                {researchSkills.map((skill, i) => {
                  const Icon = [
                    Table,
                    FileText,
                    FirstAidKit,
                    SlidersHorizontal,
                  ][i];
                  return (
                    <button
                      key={skill.id}
                      className={activeSkill === skill.id ? "active" : ""}
                      aria-pressed={activeSkill === skill.id}
                      title={skill.description}
                      onClick={() => {
                        setActiveSkill(
                          activeSkill === skill.id ? "" : skill.id,
                        );
                        if (activeSkill !== skill.id) {
                          setQuestion(
                            skill.id === "operating-metrics"
                              ? ""
                              : skill.prompt,
                          );
                        }
                      }}
                    >
                      <Icon size={17} />
                      {skill.name}
                    </button>
                  );
                })}
              </div>
              {activeSkill && (
                <div className="skill-description">
                  <span>
                    {activeSkill === "operating-metrics"
                      ? "上传多期财报，填写关注指标；留空则自动整理。"
                      : researchSkills.find((s) => s.id === activeSkill)
                          ?.description}
                    {activeSkill === "operating-metrics" &&
                      !chat?.documents.length && (
                        <button
                          className="task-upload"
                          onClick={() => file.current?.click()}
                        >
                          上传财报
                        </button>
                      )}
                    {researchSkills.find((s) => s.id === activeSkill)
                      ?.requiresDocuments && !chat?.documents.length
                      ? ""
                      : ""}
                  </span>
                  <button
                    aria-label="取消任务"
                    onClick={() => setActiveSkill("")}
                  >
                    <X size={12} />
                  </button>
                </div>
              )}

              {selected.length > 0 && (
                <div className="selection-strip">
                  <span>
                    <CheckSquare size={14} />
                    已选 {selected.length} 项研究内容
                  </span>
                  <select
                    className="report-format"
                    aria-label="研报类型"
                    value={reportFormat}
                    onChange={(e) => setReportFormat(e.target.value)}
                  >
                    <option value="full">公司研究</option>
                    <option value="brief">财报点评</option>
                  </select>
                  <button disabled={reportBusy || !!running} onClick={compile}>
                    {reportBusy ? "正在组稿…" : "编成研报"}
                    <ArrowSquareOut size={13} />
                  </button>
                </div>
              )}
              <div className="composer">
                <textarea
                  aria-label="输入研究问题"
                  placeholder={
                    activeSkill === "operating-metrics"
                      ? "关注指标，如：月活、付费用户、ARPU（可留空）"
                      : chat?.messages.length
                        ? "继续追问，或让研迹生成图表、建立测算…"
                        : "输入公司、证券代码或研究问题…"
                  }
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-controls">
                  <div>
                    <Tooltip content="上传财报或公告">
                      <button
                        className="icon-button"
                        aria-label="上传财报"
                        disabled={busy || !!running}
                        onClick={() => file.current?.click()}
                      >
                        <Paperclip size={18} />
                      </button>
                    </Tooltip>
                    <span>
                      {chat?.documents.length
                        ? `${chat.documents.length} 份本对话材料`
                        : "PDF / Word / 文本"}
                    </span>
                  </div>
                  {running ? (
                    <button
                      className="send-button stop"
                      aria-label="停止研究"
                      onClick={() =>
                        act(async () => {
                          await api(
                            `/chats/${cid}/runs/${running.id}/stop`,
                            "POST",
                          );
                        })
                      }
                    >
                      <Stop size={17} weight="fill" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="发送问题"
                      disabled={
                        (!question.trim() &&
                          activeSkill !== "operating-metrics") ||
                        busy
                      }
                      onClick={() => send()}
                    >
                      {busy ? (
                        <Spinner size="sm" color="default" />
                      ) : (
                        <ArrowUp size={20} weight="bold" />
                      )}
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-footnote">
                <span>Enter 发送 · Shift + Enter 换行</span>
              </div>
            </div>
          </main>
          {panel && (panel !== "materials" || chat?.id === cid) && (
            <aside className={"artifact-panel panel-" + panel}>
              <header>
                <div>
                  <FileText size={16} />
                  <b>
                    {
                      {
                        report: "研报草稿",
                        selected: "已选研究内容",
                        materials: "本对话材料",
                        research: "研究计划",
                      }[panel]
                    }
                  </b>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭面板"
                  onClick={() => {
                    setPanel("");
                    setView("chat");
                    setEvidenceOpen(false);
                  }}
                >
                  <X size={17} />
                </button>
              </header>
              <div className="panel-scroll">
                {panel === "materials" && (
                  <>
                    <p className="panel-intro">
                      仅当前对话可用。扫描件暂不支持文字识别。
                    </p>
                    <Button
                      fullWidth
                      className="primary"
                      isDisabled={!!running}
                      startContent={<Paperclip size={15} />}
                      onPress={() => file.current?.click()}
                    >
                      导入财报或公告
                    </Button>
                    {!!chat?.documents.length && (
                      <Button
                        fullWidth
                        variant="bordered"
                        isDisabled={!!running || busy}
                        onPress={() => {
                          setPanel("");
                          send(
                            "分析本项目全部上传报告，围绕主要经营变化形成简洁研究结论。数字引用原文，缺乏依据处明确说明。",
                          );
                        }}
                      >
                        分析全部报告
                      </Button>
                    )}
                    {chat?.documents.map((d) => (
                      <a
                        className="document-row"
                        key={d.id}
                        onClick={(e) => {
                          e.preventDefault();
                          documentOpen(d.id, 1);
                        }}
                        href={`/api/chats/${cid}/documents/${d.id}/file`}
                      >
                        <FileText size={19} />
                        <span>
                          {d.name}
                          <small>
                            {d.type.toUpperCase()} · {d.pageCount} 页 / 段
                          </small>
                        </span>
                        <ArrowSquareOut size={13} />
                      </a>
                    ))}
                  </>
                )}
                {panel === "selected" && (
                  <>
                    <p className="panel-intro">
                      以下内容将用于写作，可以移除不需要的底稿或图表。
                    </p>
                    {selected.map((c) => (
                      <div className="selected-item" key={c.id}>
                        <span>{c.title}</span>
                        <button
                          aria-label={"取消选择" + c.title}
                          onClick={() =>
                            act(() => cardChange(c, { selected: false }))
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    {!selected.length && (
                      <p className="panel-empty">
                        勾选对话卡片上的“选入研报”。
                      </p>
                    )}
                    <Button
                      className="primary"
                      fullWidth
                      isDisabled={!selected.length || !!running}
                      isLoading={compiling}
                      onPress={compile}
                    >
                      {reportFormat === "brief" ? "生成财报点评" : "编成研报"}
                    </Button>
                  </>
                )}
                {panel === "report" && (
                  <>
                    {reportBusy && (
                      <div className="report-workflow">
                        {["preparing", "writing", "reviewing", "completed"].map(
                          (stage, i) => (
                            <span
                              className={
                                chat?.reportJob?.stage === stage
                                  ? "current"
                                  : ""
                              }
                              key={stage}
                            >
                              {i + 1}.{" "}
                              {
                                [
                                  "整理底稿",
                                  "撰写章节",
                                  "核对引用与计算",
                                  "保存版本",
                                ][i]
                              }
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {compiling && (
                      <div className="report-loading">
                        <Spinner color="default" />
                        <p>正在组织已选内容…</p>
                      </div>
                    )}
                    {report && !compiling ? (
                      <>
                        <div className="report-actions">
                          <span>v{report.version} · 草稿</span>
                          <button
                            onClick={() =>
                              (location.href = `/api/chats/${cid}/export`)
                            }
                          >
                            <DownloadSimple size={14} />
                            导出 Markdown
                          </button>
                        </div>
                        {report.stale && (
                          <div className="stale-banner">
                            引用的底稿已更新，当前文档保留原版本。
                            <button onClick={compile}>重新编成研报</button>
                          </div>
                        )}
                        <h1 className="report-title">{report.title}</h1>
                        {report.review && (
                          <div className="report-review">
                            <span>
                              已核对 {report.review.sourceCount} 个来源 ·{" "}
                              {report.review.citations} 处引用
                            </span>
                            <details>
                              <summary>核对范围</summary>
                              <p>
                                {report.review.checks.join("；")}。
                                {report.review.limits}
                              </p>
                            </details>
                          </div>
                        )}
                        <nav className="report-nav">
                          {report.sections.map((s, i) => (
                            <a
                              key={s.id}
                              href={"#section-" + s.id}
                              onClick={(e) => {
                                e.preventDefault();
                                document
                                  .getElementById("section-" + s.id)
                                  ?.scrollIntoView({ behavior: "smooth" });
                              }}
                            >
                              {i + 1}. {s.title}
                            </a>
                          ))}
                        </nav>
                        {report.sections.map((s) => (
                          <section
                            className="report-section"
                            id={"section-" + s.id}
                            key={s.id}
                          >
                            <div>
                              <h2>{s.title}</h2>
                              <div className="section-edit-actions">
                                <button
                                  aria-label={"让AI修改" + s.title}
                                  onClick={() => {
                                    setEditing("ai-" + s.id);
                                    setEditText("");
                                    setEditVersion(report.version);
                                  }}
                                >
                                  修改／补查
                                </button>
                                <button
                                  aria-label={"编辑" + s.title}
                                  onClick={() => {
                                    setEditing(s.id);
                                    setEditText(s.content);
                                    setEditVersion(report.version);
                                  }}
                                >
                                  编辑
                                </button>
                              </div>
                            </div>
                            {editing === "ai-" + s.id ? (
                              <>
                                <Textarea
                                  label="修改要求"
                                  placeholder="例如：压缩到100字，把事实和推断分开，保留来源。"
                                  value={editText}
                                  onValueChange={setEditText}
                                  minRows={3}
                                />
                                <div className="inline-actions">
                                  <Button
                                    className="primary"
                                    size="sm"
                                    isLoading={busy}
                                    onPress={() =>
                                      act(async () => {
                                        const result = await api(
                                          `/chats/${cid}/report/revise`,
                                          "POST",
                                          {
                                            sectionId: s.id,
                                            instruction: editText,
                                          },
                                        );
                                        setEditText(result.content);
                                        setEditVersion(result.baseVersion);
                                        setEditing(s.id);
                                      })
                                    }
                                  >
                                    只改措辞
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="bordered"
                                    isDisabled={!!running}
                                    isLoading={busy}
                                    onPress={() =>
                                      act(() => researchSection(s.id, editText))
                                    }
                                  >
                                    补查并修订
                                  </Button>
                                  <button onClick={() => setEditing("")}>
                                    取消
                                  </button>
                                </div>
                              </>
                            ) : editing === s.id ? (
                              <>
                                <Textarea
                                  aria-label="章节正文"
                                  value={editText}
                                  onValueChange={setEditText}
                                  minRows={8}
                                />
                                <div className="inline-actions">
                                  <Button
                                    size="sm"
                                    className="primary"
                                    isLoading={busy}
                                    onPress={() =>
                                      act(async () => {
                                        const current = chatRef.current!;
                                        update(
                                          await api(
                                            `/chats/${cid}/report`,
                                            "PATCH",
                                            {
                                              revision: current.revision,
                                              version: editVersion,
                                              sectionId: s.id,
                                              content: editText,
                                            },
                                          ),
                                        );
                                        setEditing("");
                                      })
                                    }
                                  >
                                    保存
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="light"
                                    onPress={() => setEditing("")}
                                  >
                                    取消
                                  </Button>
                                </div>
                              </>
                            ) : (
                              <Markdown
                                text={s.content}
                                onSource={sourceOpen}
                              />
                            )}
                          </section>
                        ))}
                        {report.artifacts.length > 0 && (
                          <div className="report-artifacts">
                            <h2>图表与数据附录</h2>
                            {report.artifacts.map((c) => (
                              <ResearchCard
                                key={c.id}
                                card={c}
                                onChange={async () => {}}
                                onSource={sourceOpen}
                                onChart={() => {}}
                                readOnly
                              />
                            ))}
                          </div>
                        )}
                        <details className="version-list">
                          <summary>
                            版本记录 · {chat?.reports.length || 0} 个历史版本
                          </summary>
                          {chat?.reports
                            .slice()
                            .reverse()
                            .map((r) => (
                              <p key={r.id}>
                                v{r.version} ·{" "}
                                {new Date(r.at).toLocaleString("zh-CN")}
                              </p>
                            ))}
                        </details>
                      </>
                    ) : (
                      !compiling && (
                        <div className="panel-empty">
                          <FileText size={28} />
                          <h3>从研究内容生成草稿</h3>
                          <p>先勾选需要的发现、图表或假设，再编成研报。</p>
                          <Button
                            className="primary"
                            isDisabled={!selected.length}
                            onPress={compile}
                          >
                            编成研报
                            {selected.length
                              ? " · " + selected.length + " 项"
                              : ""}
                          </Button>
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
            </aside>
          )}
          {evidenceOpen && source && (
            <EvidencePanel
              source={source}
              cid={cid}
              onClose={() => setEvidenceOpen(false)}
            />
          )}
        </div>
      </div>
      <input
        ref={file}
        type="file"
        hidden
        accept=".pdf,.docx,.txt,.md"
        multiple
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = "";
          if (!files.length) return;
          await act(async () => {
            const c = await ensureChat();
            for (const f of files) {
              const data = new FormData();
              data.append("file", f);
              update(await api("/chats/" + c.id + "/documents", "POST", data));
            }
          });
        }}
      />
      <Modal
        isOpen={!!modal}
        onOpenChange={(open) => !open && setModal("")}
        size={modal === "source" ? "3xl" : "xl"}
        scrollBehavior="inside"
        classNames={{ base: "yanji-modal", backdrop: "yanji-backdrop" }}
      >
        <ModalContent>
          <ModalHeader>
            {modal === "source" ? "来源与计算依据" : "模型连接"}
          </ModalHeader>
          <ModalBody>
            {modal === "settings" ? (
              <>
                <Input
                  label="API 地址"
                  value={form.baseUrl}
                  onValueChange={(baseUrl) => setForm({ ...form, baseUrl })}
                />
                <Input
                  label="模型名称"
                  value={form.model}
                  onValueChange={(model) => setForm({ ...form, model })}
                />
                <Input
                  label="API Key"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    settings.hasKey ? "已保存，留空保留" : "输入 API Key"
                  }
                  value={form.key}
                  onValueChange={(key) => setForm({ ...form, key })}
                />
                <p className="muted small">
                  连接仅保存在本机。模型会读取本次研究所需的材料片段。
                  {settings.inherited ? "当前沿用本机研迹中已保存的连接。" : ""}
                </p>
              </>
            ) : (
              source && (
                <>
                  <h3>{source.name}</h3>
                  <div className="source-meta">
                    <span>
                      {source.type === "pdf"
                        ? "PDF物理页 " + source.page
                        : source.type === "web"
                          ? "数据快照"
                          : "文本段落 " + source.page}
                    </span>
                    <span>
                      {source.date
                        ? new Date(source.date).toLocaleString("zh-CN")
                        : ""}
                    </span>
                  </div>
                  {source.data?.unit && (
                    <p className="muted">{source.data.unit}</p>
                  )}
                  {source.type === "web" &&
                  source.data?.rows?.some((r: any) => "revenue" in r) ? (
                    <>
                      <FinancialTable
                        data={source.data}
                        sourceId={source.id}
                        onSource={() => {}}
                      />
                      <details className="raw-source">
                        <summary>查看原始数据快照与申报字段</summary>
                        <pre className="source-text">{source.text}</pre>
                      </details>
                    </>
                  ) : (
                    <pre className="source-text">{source.text}</pre>
                  )}
                  {source.sourceUrl ? (
                    <a
                      className="source-original"
                      href={source.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开数据源 <ArrowSquareOut size={14} />
                    </a>
                  ) : (
                    source.documentId && (
                      <a
                        className="source-original"
                        target="_blank"
                        rel="noreferrer"
                        href={`/api/chats/${cid}/documents/${source.documentId}/file#page=${source.page}`}
                      >
                        打开财报第 {source.page} 页 <ArrowSquareOut size={14} />
                      </a>
                    )
                  )}
                  {chat?.runs
                    .flatMap((r) => (r as any).records || [])
                    .filter(
                      (r: any) =>
                        r.name === "calculate" &&
                        r.result?.sourceIds?.includes(source.id),
                    )
                    .map((r: any, i: number) => (
                      <div className="calculation-source" key={i}>
                        <span>确定性计算 · {r.result.operation}</span>
                        <b>
                          {r.result.values.join("，")} →{" "}
                          {Number(r.result.result.toPrecision(10))}
                        </b>
                      </div>
                    ))}
                </>
              )
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setModal("")}>
              关闭
            </Button>
            {modal === "settings" && (
              <Button
                className="primary"
                isLoading={busy}
                onPress={() =>
                  act(async () => {
                    setSettings(await api("/settings", "PUT", form));
                    setForm({ ...form, key: "" });
                    setModal("");
                  })
                }
              >
                保存连接
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
