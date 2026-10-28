import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const dataDir = path.resolve(process.env.CHAT_DATA_DIR || "data");
fs.mkdirSync(path.join(dataDir, "files"), { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(dataDir, "chat.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
);
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function listChats() {
  return db
    .prepare("SELECT body FROM chats")
    .all()
    .map((r) => JSON.parse(r.body))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function getProject(cid) {
  const row = db.prepare("SELECT body FROM chats WHERE id=?").get(cid);
  if (!row) throw Object.assign(new Error("对话不存在"), { status: 404 });
  return JSON.parse(row.body);
}
export function putProject(c) {
  c.updatedAt = now();
  db.prepare("INSERT OR REPLACE INTO chats VALUES(?,?)").run(
    c.id,
    JSON.stringify(c),
  );
  return c;
}
export function createChat() {
  return putProject({
    id: id(),
    title: "新研究",
    at: now(),
    revision: 0,
    messages: [],
    cards: [],
    documents: [],
    researchSources: [],
    runs: [],
    reports: [],
    report: null,
  });
}
export function edit(cid, revision, fn) {
  const c = getProject(cid);
  if (c.revision !== revision)
    throw Object.assign(new Error("内容已更新，请刷新后再试"), { status: 409 });
  fn(c);
  c.revision++;
  return putProject(c);
}
export function publicChat(c) {
  return {
    ...c,
    documentAnalysisCache: undefined,
    runs: c.runs.map(({ checkpoint, ...r }) => ({
      ...r,
      memory: checkpoint
        ? {
            round: checkpoint.step,
            observedSources: checkpoint.seen.length,
            retainedMessages: checkpoint.messages.length,
            at: checkpoint.at,
          }
        : null,
    })),
    documents: c.documents.map(({ file, pages, chunks, ...d }) => ({
      ...d,
      pageCount: pages.length,
    })),
    researchSources: c.researchSources.map(({ text, data, ...s }) => s),
  };
}
const kp = path.join(dataDir, ".key");
if (!fs.existsSync(kp)) fs.writeFileSync(kp, randomBytes(32), { mode: 0o600 });
function encrypt(s) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", fs.readFileSync(kp), iv);
  return [
    iv.toString("hex"),
    Buffer.concat([c.update(s, "utf8"), c.final()]).toString("hex"),
    c.getAuthTag().toString("hex"),
  ].join(".");
}
function decrypt(s) {
  if (!s) return "";
  const [iv, v, tag] = s.split(".");
  const d = createDecipheriv(
    "aes-256-gcm",
    fs.readFileSync(kp),
    Buffer.from(iv, "hex"),
  );
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(v, "hex")), d.final()]).toString();
}
function inherited() {
  if (process.env.YANJI_IMPORT_LEGACY_SETTINGS !== "1" || process.env.CHAT_NO_INHERIT === "1") return {};
  const old = path.resolve("../thesis-ledger/data");
  if (!fs.existsSync(path.join(old, "ledger.sqlite"))) return {};
  let conn;
  try {
    conn = new DatabaseSync(path.join(old, "ledger.sqlite"), {
      readOnly: true,
    });
    const raw = conn.prepare("SELECT body FROM settings WHERE id=1").get();
    if (!raw) return {};
    const s = JSON.parse(raw.body);
    if (!s.key) return s;
    const [a, b, c] = s.key.split(".");
    const d = createDecipheriv(
      "aes-256-gcm",
      fs.readFileSync(path.join(old, ".credential-key")),
      Buffer.from(a, "hex"),
    );
    d.setAuthTag(Buffer.from(b, "hex"));
    return {
      ...s,
      key: Buffer.concat([
        d.update(Buffer.from(c, "hex")),
        d.final(),
      ]).toString(),
    };
  } catch {
    return {};
  } finally {
    conn?.close();
  }
}
export function settings() {
  const row = db.prepare("SELECT body FROM settings WHERE id=1").get();
  const own = row ? JSON.parse(row.body) : null,
    old = own ? {} : inherited();
  return {
    baseUrl:
      process.env.LLM_BASE_URL ||
      own?.baseUrl ||
      old.baseUrl ||
      "https://api.deepseek.com",
    model: process.env.LLM_MODEL || own?.model || old.model || "deepseek-flash",
    key: process.env.LLM_API_KEY || (own ? decrypt(own.key) : old.key) || "",
    inherited: !own && !!old.key,
  };
}
export function publicSettings() {
  const s = settings();
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    hasKey: !!s.key,
    inherited: s.inherited,
  };
}
export function saveSettings(input) {
  const current = settings(),
    baseUrl = String(input.baseUrl || current.baseUrl)
      .trim()
      .replace(/\/$/, "");
  const u = new URL(baseUrl);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("模型地址格式不正确");
  db.prepare("INSERT OR REPLACE INTO settings VALUES(1,?)").run(
    JSON.stringify({
      baseUrl,
      model: String(input.model || current.model).trim(),
      key: encrypt(input.key || current.key),
    }),
  );
  return publicSettings();
}
