"""原有 SQLite 数据与 AES-GCM 配置的 Python 适配器。

继续读写相同 JSON 字段，前端和旧对话无需迁移。密钥不进入公开响应或日志。
"""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from ..common import AppError, clone, dumps, now, uid


class Store:
    """应用/SessionStore 调用；负责持久化，不负责模型决策。"""

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        (self.data_dir / "files").mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(
            self.data_dir / "chat.sqlite", isolation_level=None, check_same_thread=False
        )
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.executescript(
            "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,body TEXT NOT NULL);"
        )
        self.key_path = self.data_dir / ".key"
        if not self.key_path.exists():
            fd = os.open(self.key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as file:
                file.write(os.urandom(32))

    @contextmanager
    def transaction(self):
        # 事务中只比较/提交数据，不等待网络，避免长时间占用写锁。
        """SessionStore/用户编辑调用；短事务内比较和写入，不在锁中等待网络。"""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def get(self, cid):
        """仓库调用者读取会话副本；修改返回值不会自动保存。"""
        row = self.db.execute("SELECT body FROM chats WHERE id=?", (cid,)).fetchone()
        if not row:
            raise AppError("对话不存在", 404)
        return json.loads(row["body"])

    def put(self, chat):
        """显式保存完整会话；不负责Agent决策，执行写入应经SessionStore。"""
        chat["updatedAt"] = now()
        self.db.execute(
            "INSERT OR REPLACE INTO chats VALUES(?,?)", (chat["id"], dumps(chat))
        )
        return chat

    def list(self):
        """应用列出会话副本；不将私有原文直接推给前端。"""
        return sorted(
            (
                json.loads(row["body"])
                for row in self.db.execute("SELECT body FROM chats")
            ),
            key=lambda c: c.get("updatedAt", ""),
            reverse=True,
        )

    def create(self):
        """HTTP新建空对话；不复制其他对话的附件和研究结果。"""
        return self.put(
            dict(
                id=uid(),
                title="新研究",
                at=now(),
                revision=0,
                messages=[],
                cards=[],
                documents=[],
                researchSources=[],
                runs=[],
                reports=[],
                report=None,
            )
        )

    def edit(self, cid, revision, change):
        """HTTP用户编辑调用；通过revision防止旧页面覆盖新内容，不调用模型。"""
        with self.transaction():
            chat = self.get(cid)
            if chat["revision"] != revision:
                raise AppError("内容已更新，请刷新后再试", 409)
            change(chat)
            chat["revision"] += 1
            return self.put(chat)

    def settings(self):
        """模型端口读取运行配置；仅内部可见，公开响应必须使用public_settings。"""
        row = self.db.execute("SELECT body FROM settings WHERE id=1").fetchone()
        own = json.loads(row["body"]) if row else {}
        encrypted = own.get("key")
        key = ""
        if encrypted:
            # Node 存储格式：iv.密文.tag；AESGCM 接口接收 密文+tag。
            iv, ciphertext, tag = (bytes.fromhex(x) for x in encrypted.split("."))
            key = (
                AESGCM(self.key_path.read_bytes())
                .decrypt(iv, ciphertext + tag, None)
                .decode()
            )
        inherited = False
        # 公开版默认不读取其他项目的配置；需要用户显式选择兼容导入。
        if (
            not own
            and os.getenv("YANJI_IMPORT_LEGACY_SETTINGS") == "1"
            and os.getenv("CHAT_NO_INHERIT") != "1"
        ):
            old = self.data_dir.parent.parent / "thesis-ledger" / "data"
            try:
                conn = sqlite3.connect(
                    f"file:{old / 'ledger.sqlite'}?mode=ro", uri=True
                )
                try:
                    legacy = json.loads(
                        conn.execute("SELECT body FROM settings WHERE id=1").fetchone()[
                            0
                        ]
                    )
                finally:
                    conn.close()
                if legacy.get("key"):
                    iv, tag, ciphertext = (
                        bytes.fromhex(x) for x in legacy["key"].split(".")
                    )
                    key = (
                        AESGCM((old / ".credential-key").read_bytes())
                        .decrypt(iv, ciphertext + tag, None)
                        .decode()
                    )
                    own = {k: v for k, v in legacy.items() if k != "key"}
                    inherited = True
            except (OSError, sqlite3.Error, TypeError, ValueError):
                pass
        return dict(
            baseUrl=os.getenv("LLM_BASE_URL")
            or own.get("baseUrl")
            or "https://api.deepseek.com",
            model=os.getenv("LLM_MODEL") or own.get("model") or "deepseek-flash",
            key=os.getenv("LLM_API_KEY") or key,
            inherited=inherited,
        )

    def public_settings(self):
        """设置页面读取脱敏状态；不返回解密后的Key。"""
        data = self.settings()
        return {k: v for k, v in data.items() if k != "key"} | {
            "hasKey": bool(data["key"])
        }

    def save_settings(self, data):
        """设置接口调用；校验地址并加密Key，不把凭据放入对话上下文。"""
        current = self.settings()
        url = str(data.get("baseUrl") or current["baseUrl"]).strip().rstrip("/")
        parsed = urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise AppError("模型地址格式不正确")
        iv = os.urandom(12)
        encrypted = AESGCM(self.key_path.read_bytes()).encrypt(
            iv, str(data.get("key") or current["key"]).encode(), None
        )
        value = dict(
            baseUrl=url,
            model=str(data.get("model") or current["model"]).strip(),
            key=".".join(x.hex() for x in (iv, encrypted[:-16], encrypted[-16:])),
        )
        self.db.execute("INSERT OR REPLACE INTO settings VALUES(1,?)", (dumps(value),))
        return self.public_settings()


def public_chat(chat):
    """HTTP/SSE 的脱敏投影；完整原文、文件路径和上下文留在本机。"""
    result = clone(chat)
    result.pop("documentAnalysisCache", None)
    for run in result["runs"]:
        checkpoint = run.pop("checkpoint", None)
        run["memory"] = (
            dict(
                round=checkpoint.get("step", 0),
                observedSources=len(checkpoint.get("seen", [])),
                retainedMessages=len(checkpoint.get("messages", [])),
                at=checkpoint.get("at"),
            )
            if checkpoint
            else None
        )
    for doc in result["documents"]:
        doc["pageCount"] = len(doc.pop("pages", []))
        doc.pop("file", None)
        doc.pop("chunks", None)
    for source in result["researchSources"]:
        source.pop("text", None)
        source.pop("data", None)
    return result
