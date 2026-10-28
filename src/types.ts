export type Card = {
  id: string;
  kind:
    | "worksheet"
    | "documentAnalysis"
    | "revision"
    | "filings"
    | "market"
    | "financials"
    | "chart"
    | "brief"
    | "gaps"
    | "scenario";
  title: string;
  data: any;
  sourceIds: string[];
  selected: boolean;
  version: number;
  at: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  cardIds: string[];
  at: string;
};
export type Run = {
  id: string;
  messageId: string;
  status: string;
  question: string;
  mode?: string;
  sourceMode?: string;
  route?: { intent: string; sourceMode: string; reason: string };
  documentProgress?: {
    id: string;
    name: string;
    status: string;
    pages: number;
    processedPages?: number;
    parts?: number;
    completedParts?: number;
    cached?: boolean;
  }[];
  stage?: string;
  round?: number;
  plan?: { goal: string; steps: string[] };
  memory?: {
    round: number;
    observedSources: number;
    retainedMessages: number;
    at: string;
  } | null;
  liveText?: string;
  error?: string;
  events: { at: string; label: string; detail: string }[];
  usage?: number;
};
export type Source = {
  id: string;
  documentId: string;
  name: string;
  page: number;
  type: string;
  date?: string;
  sourceUrl?: string;
  text: string;
  data?: any;
};
export type Report = {
  id: string;
  title: string;
  version: number;
  at: string;
  stale: boolean;
  review?: {
    sourceCount: number;
    citations: number;
    checks: string[];
    limits: string;
  };
  sections: { id: string; title: string; content: string }[];
  artifacts: Card[];
  sourceIds: string[];
  cardVersions: Record<string, number>;
};
export type Chat = {
  archived?: boolean;
  id: string;
  title: string;
  revision: number;
  messages: Message[];
  cards: Card[];
  runs: Run[];
  documents: { id: string; name: string; type: string; pageCount: number }[];
  researchPlan?: {
    goal: string;
    steps: string[];
    gaps: {
      id: string;
      question: string;
      dimension: string;
      status: "open" | "blocked" | "answered";
      note: string;
      sourceIds: string[];
    }[];
  };
  reportJob?: { status: string; stage: string; error?: string };
  report: Report | null;
  reports: Report[];
};
export type Summary = {
  archived?: boolean;
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
};
