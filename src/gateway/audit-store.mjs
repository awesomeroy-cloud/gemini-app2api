/** Persistent SQLite request/response audit store (zero runtime dependencies, node:sqlite). */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let cachedDatabaseSync = null;
function loadDatabaseSync() {
  if (!cachedDatabaseSync) cachedDatabaseSync = require("node:sqlite").DatabaseSync;
  return cachedDatabaseSync;
}

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_REPLY_BYTES = 512 * 1024;
const MAX_REASONING_BYTES = 512 * 1024;
const MAX_RENDERED_PROMPT_BYTES = 256 * 1024;
const MAX_TOOL_CALLS_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const PREVIEW_MAX_CHARS = 200;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_ROWS = 10000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const DATA_URI_RE = /data:((?:image|audio|video)\/[a-zA-Z0-9.+_-]+)(?:;[a-zA-Z0-9=_-]+)*;base64,[A-Za-z0-9+/=_\r\n-]+/g;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-csrf-token", "x-api-key", "proxy-authorization"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_meta (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id          TEXT NOT NULL DEFAULT '',
  ts              INTEGER NOT NULL,
  client_ip       TEXT NOT NULL DEFAULT '',
  method          TEXT NOT NULL DEFAULT '',
  path            TEXT NOT NULL DEFAULT '',
  model           TEXT NOT NULL DEFAULT '',
  served_model    TEXT NOT NULL DEFAULT '',
  stream          INTEGER NOT NULL DEFAULT 0,
  status          INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  ttfb_ms         INTEGER NOT NULL DEFAULT 0,
  total_ms        INTEGER NOT NULL DEFAULT 0,
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  account         TEXT NOT NULL DEFAULT '',
  key_fp          TEXT NOT NULL DEFAULT '',
  issue           TEXT NOT NULL DEFAULT '',
  finish_reason   TEXT NOT NULL DEFAULT '',
  request_preview TEXT NOT NULL DEFAULT '',
  reply_preview   TEXT NOT NULL DEFAULT '',
  error_preview   TEXT NOT NULL DEFAULT '',
  user_agent      TEXT NOT NULL DEFAULT '',
  raw_bytes       INTEGER NOT NULL DEFAULT 0,
  raw_truncated   INTEGER NOT NULL DEFAULT 0,
  first_data_ms   INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  chunks          INTEGER NOT NULL DEFAULT 0,
  frames          INTEGER NOT NULL DEFAULT 0,
  thinking_level  INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX IF NOT EXISTS idx_audit_meta_ts ON audit_meta(ts);
CREATE INDEX IF NOT EXISTS idx_audit_meta_status ON audit_meta(status);
CREATE INDEX IF NOT EXISTS idx_audit_meta_model ON audit_meta(model);
CREATE INDEX IF NOT EXISTS idx_audit_meta_account ON audit_meta(account);
CREATE INDEX IF NOT EXISTS idx_audit_meta_issue ON audit_meta(issue);
CREATE INDEX IF NOT EXISTS idx_audit_meta_path ON audit_meta(path);

CREATE TABLE IF NOT EXISTS audit_body (
  id              INTEGER PRIMARY KEY,
  request_body    TEXT NOT NULL DEFAULT '',
  reply           TEXT NOT NULL DEFAULT '',
  tool_calls      TEXT NOT NULL DEFAULT '',
  error           TEXT NOT NULL DEFAULT '',
  params          TEXT NOT NULL DEFAULT '',
  req_headers     TEXT NOT NULL DEFAULT '',
  reasoning       TEXT NOT NULL DEFAULT '',
  res_headers     TEXT NOT NULL DEFAULT '',
  rendered_prompt TEXT NOT NULL DEFAULT '',
  annotations     TEXT NOT NULL DEFAULT '',
  quota_snapshot  TEXT NOT NULL DEFAULT '',
  failover_chain  TEXT NOT NULL DEFAULT '',
  native_evidence TEXT NOT NULL DEFAULT ''
);
`;

function truncateUtf8(str, maxBytes) {
  if (typeof str !== "string" || !str) return { text: "", truncated: false, bytes: 0 };
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return { text: str, truncated: false, bytes: buf.length };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true, bytes: buf.length };
}

function previewText(str, maxChars = PREVIEW_MAX_CHARS) {
  if (typeof str !== "string" || !str) return "";
  const cleaned = str.replace(DATA_URI_RE, (_, mime) => `[${mime}]`).replace(/\s+/g, " ").trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "…" : cleaned;
}

export function sanitizeBase64(str) {
  if (typeof str !== "string" || !str) return "";
  return str.replace(DATA_URI_RE, (match, mime) => `[media:${mime} ${match.length} chars redacted]`);
}

export function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (SENSITIVE_HEADERS.has(key)) out[key] = "[REDACTED]";
    else if (typeof v === "string") out[key] = v.slice(0, 512);
    else if (typeof v === "number") out[key] = String(v);
    else if (Array.isArray(v)) out[key] = v.map((s) => String(s).slice(0, 512)).join(", ");
  }
  return out;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (typeof item?.text === "string") parts.push(item.text);
    else if (item?.type === "image_url" || item?.type === "input_image") parts.push("[image]");
  }
  return parts.join(" ");
}

export function extractRequestPreview(body) {
  if (!body || typeof body !== "object") return "";
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m?.role === "user") {
        const text = previewText(textFromContent(m.content));
        if (text) return text;
      }
    }
    const last = body.messages[body.messages.length - 1];
    if (last) return previewText(textFromContent(last.content));
  }
  if (typeof body.input === "string") return previewText(body.input);
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i];
      if (item?.role === "user") {
        const text = previewText(textFromContent(item.content));
        if (text) return text;
      }
      if (typeof item?.text === "string") {
        const text = previewText(item.text);
        if (text) return text;
      }
    }
  }
  if (typeof body.prompt === "string") return previewText(body.prompt);
  return "";
}

export function extractClientIp(req) {
  const real = req?.headers?.["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim().slice(0, 64);
  const fwd = req?.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim().slice(0, 64);
  const addr = req?.socket?.remoteAddress;
  return typeof addr === "string" ? addr.replace(/^::ffff:/, "").slice(0, 64) : "";
}

export class AuditStore {
  constructor(directory, { retentionDays, maxRows = MAX_ROWS } = {}) {
    const parsedRetention = Number(retentionDays ?? process.env.GATEWAY_AUDIT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
    this.retentionDays = Number.isFinite(parsedRetention) && parsedRetention > 0 ? Math.min(365, Math.floor(parsedRetention)) : DEFAULT_RETENTION_DAYS;
    this.maxRows = maxRows;
    this.directory = directory;
    this.dbPath = directory ? path.join(directory, "audit.db") : ":memory:";
    this.db = null;
    this.pruneTimer = null;
    if (!directory || fs.existsSync(this.dbPath)) {
      this._open();
    }
  }

  _open() {
    if (this.db) return this.db;
    try {
      if (this.directory) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const DatabaseSync = loadDatabaseSync();
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      this.db.exec(SCHEMA);
      this._migrate();
      if (this.directory && fs.existsSync(this.dbPath)) {
        try { fs.chmodSync(this.dbPath, 0o600); } catch {}
      }
      this.prune();
      if (!this.pruneTimer) {
        this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
        this.pruneTimer.unref();
      }
    } catch {
      this.db = null;
    }
    return this.db;
  }

  _migrate() {
    if (!this.db) return;
    const ensureColumns = (table, cols) => {
      const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
      for (const [name, ddl] of cols) {
        if (!existing.has(name)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
        }
      }
    };
    ensureColumns("audit_meta", [
      ["first_data_ms", "INTEGER NOT NULL DEFAULT 0"],
      ["reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"],
      ["chunks", "INTEGER NOT NULL DEFAULT 0"],
      ["frames", "INTEGER NOT NULL DEFAULT 0"],
      ["thinking_level", "INTEGER NOT NULL DEFAULT -1"],
    ]);
    ensureColumns("audit_body", [
      ["reasoning", "TEXT NOT NULL DEFAULT ''"],
      ["res_headers", "TEXT NOT NULL DEFAULT ''"],
      ["rendered_prompt", "TEXT NOT NULL DEFAULT ''"],
      ["annotations", "TEXT NOT NULL DEFAULT ''"],
      ["quota_snapshot", "TEXT NOT NULL DEFAULT ''"],
      ["failover_chain", "TEXT NOT NULL DEFAULT ''"],
      ["native_evidence", "TEXT NOT NULL DEFAULT ''"],
    ]);
  }

  record(entry) {
    if (!this._open()) return null;
    try {
      const ts = Number.isFinite(entry.ts) ? Math.floor(entry.ts) : Date.now();
      let reqJson = "";
      try { reqJson = entry.requestBody ? sanitizeBase64(JSON.stringify(entry.requestBody)) : ""; } catch { reqJson = ""; }
      const reqCap = truncateUtf8(reqJson, MAX_REQUEST_BODY_BYTES);
      const replyStr = typeof entry.reply === "string" ? entry.reply : "";
      const replyCap = truncateUtf8(replyStr, MAX_REPLY_BYTES);
      const reasoningStr = typeof entry.reasoning === "string" ? entry.reasoning : "";
      const reasoningCap = truncateUtf8(reasoningStr, MAX_REASONING_BYTES);
      const reasoningTokens = Number.isFinite(entry.reasoningTokens)
        ? Math.max(0, Math.floor(Number(entry.reasoningTokens)))
        : (reasoningStr ? Math.ceil(Buffer.byteLength(reasoningStr, "utf8") / 3.5) : 0);
      const renderedPromptStr = typeof entry.renderedPrompt === "string" ? sanitizeBase64(entry.renderedPrompt) : "";
      const renderedPromptCap = truncateUtf8(renderedPromptStr, MAX_RENDERED_PROMPT_BYTES);
      let toolsJson = "";
      try { toolsJson = Array.isArray(entry.toolCalls) && entry.toolCalls.length ? JSON.stringify(entry.toolCalls) : ""; } catch { toolsJson = ""; }
      const toolsCap = truncateUtf8(toolsJson, MAX_TOOL_CALLS_BYTES);
      let errJson = "";
      try { errJson = entry.error ? (typeof entry.error === "string" ? entry.error : JSON.stringify(entry.error)) : ""; } catch { errJson = ""; }
      const errCap = truncateUtf8(errJson, MAX_ERROR_BYTES);
      let paramsJson = "";
      try { paramsJson = entry.params ? JSON.stringify(entry.params) : ""; } catch { paramsJson = ""; }
      let headersJson = "";
      try { headersJson = entry.reqHeaders ? JSON.stringify(sanitizeHeaders(entry.reqHeaders)) : ""; } catch { headersJson = ""; }
      let resHeadersJson = "";
      try { resHeadersJson = entry.resHeaders && Object.keys(entry.resHeaders).length ? JSON.stringify(sanitizeHeaders(entry.resHeaders)) : ""; } catch { resHeadersJson = ""; }
      const resHeadersCap = truncateUtf8(resHeadersJson, MAX_ERROR_BYTES);
      let annotationsJson = "";
      try { annotationsJson = entry.annotations ? JSON.stringify(entry.annotations) : ""; } catch { annotationsJson = ""; }
      const annotationsCap = truncateUtf8(annotationsJson, MAX_TOOL_CALLS_BYTES);
      let quotaSnapshotJson = "";
      try { quotaSnapshotJson = entry.quotaSnapshot ? JSON.stringify(entry.quotaSnapshot) : ""; } catch { quotaSnapshotJson = ""; }
      const quotaSnapshotCap = truncateUtf8(quotaSnapshotJson, MAX_ERROR_BYTES);
      let failoverChainJson = "";
      try { failoverChainJson = Array.isArray(entry.failoverChain) && entry.failoverChain.length ? JSON.stringify(entry.failoverChain) : ""; } catch { failoverChainJson = ""; }
      const failoverChainCap = truncateUtf8(failoverChainJson, MAX_ERROR_BYTES);
      let nativeEvidenceJson = "";
      try { nativeEvidenceJson = entry.nativeEvidence ? JSON.stringify(entry.nativeEvidence) : ""; } catch { nativeEvidenceJson = ""; }
      const nativeEvidenceCap = truncateUtf8(nativeEvidenceJson, MAX_ERROR_BYTES);

      const reqPreview = entry.requestPreview || extractRequestPreview(entry.requestBody);
      let replyPreview = previewText(replyStr);
      if (!replyPreview && Array.isArray(entry.toolCalls) && entry.toolCalls.length) {
        const names = entry.toolCalls.map((c) => c?.name || c?.function?.name || "tool").slice(0, 5).join(", ");
        replyPreview = `[tool_calls: ${names}]`;
      }
      const errorPreview = previewText(entry.errorCode || (typeof entry.error === "string" ? entry.error : entry.error?.code || entry.error?.message || ""));
      const rawBytes = reqCap.bytes + replyCap.bytes + reasoningCap.bytes + renderedPromptCap.bytes + toolsCap.bytes + errCap.bytes + annotationsCap.bytes + quotaSnapshotCap.bytes + failoverChainCap.bytes + nativeEvidenceCap.bytes;
      const rawTruncated = reqCap.truncated || replyCap.truncated || reasoningCap.truncated || renderedPromptCap.truncated || toolsCap.truncated || errCap.truncated || resHeadersCap.truncated || annotationsCap.truncated || quotaSnapshotCap.truncated || failoverChainCap.truncated || nativeEvidenceCap.truncated ? 1 : 0;
      const thinkingLevel = Number.isSafeInteger(entry.thinkingLevel) ? entry.thinkingLevel : -1;

      this.db.exec("BEGIN");
      try {
        const metaStmt = this.db.prepare(`
          INSERT INTO audit_meta (
            req_id, ts, client_ip, method, path, model, served_model, stream, status, failed,
            ttfb_ms, total_ms, prompt_tokens, output_tokens, total_tokens, tool_call_count,
            attempts, account, key_fp, issue, finish_reason, request_preview, reply_preview,
            error_preview, user_agent, raw_bytes, raw_truncated,
            first_data_ms, reasoning_tokens, chunks, frames, thinking_level
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?
          )
        `);
        const info = metaStmt.run(
          String(entry.reqId || ""),
          ts,
          String(entry.clientIp || ""),
          String(entry.method || "POST"),
          String(entry.path || ""),
          String(entry.model || ""),
          String(entry.servedModel || ""),
          entry.stream ? 1 : 0,
          Number(entry.status || 0),
          entry.failed ? 1 : 0,
          Math.max(0, Math.floor(Number(entry.ttfbMs || 0))),
          Math.max(0, Math.floor(Number(entry.totalMs || 0))),
          Math.max(0, Math.floor(Number(entry.promptTokens || 0))),
          Math.max(0, Math.floor(Number(entry.outputTokens || 0))),
          Math.max(0, Math.floor(Number(entry.totalTokens || 0))),
          Math.max(0, Math.floor(Number(entry.toolCallCount || 0))),
          Math.max(0, Math.floor(Number(entry.attempts || 0))),
          String(entry.account || ""),
          String(entry.keyFp || ""),
          String(entry.issue || ""),
          String(entry.finishReason || ""),
          reqPreview,
          replyPreview,
          errorPreview,
          String(entry.userAgent || "").slice(0, 256),
          rawBytes,
          rawTruncated,
          Math.max(0, Math.floor(Number(entry.firstDataMs || 0))),
          reasoningTokens,
          Math.max(0, Math.floor(Number(entry.chunks || 0))),
          Math.max(0, Math.floor(Number(entry.frames || 0))),
          thinkingLevel,
        );
        const id = Number(info.lastInsertRowid);
        this.db.prepare(`
          INSERT INTO audit_body (
            id, request_body, reply, tool_calls, error, params, req_headers,
            reasoning, res_headers, rendered_prompt, annotations, quota_snapshot, failover_chain, native_evidence
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, reqCap.text, replyCap.text, toolsCap.text, errCap.text, paramsJson, headersJson,
          reasoningCap.text, resHeadersCap.text, renderedPromptCap.text, annotationsCap.text, quotaSnapshotCap.text, failoverChainCap.text, nativeEvidenceCap.text,
        );
        this.db.exec("COMMIT");
        return id;
      } catch (innerErr) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw innerErr;
      }
    } catch {
      return null;
    }
  }

  sizeBytes() {
    if (!this.directory) return 0;
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { total += fs.statSync(this.dbPath + suffix).size; } catch {}
    }
    return total;
  }

  facets() {
    if (!this.db) return { models: [], accounts: [], issues: [], finishes: [], paths: [], total_count: 0, retention_days: this.retentionDays, size_bytes: 0 };
    const distinct = (col) => this.db.prepare(`SELECT DISTINCT ${col} AS v FROM audit_meta WHERE ${col} != '' ORDER BY ${col}`).all().map((r) => r.v);
    const totalCount = this.db.prepare("SELECT COUNT(*) AS c FROM audit_meta").get()?.c ?? 0;
    return {
      models: distinct("model"),
      accounts: distinct("account"),
      issues: distinct("issue"),
      finishes: distinct("finish_reason"),
      paths: distinct("path"),
      total_count: Number(totalCount),
      retention_days: this.retentionDays,
      size_bytes: this.sizeBytes(),
    };
  }

  list(query = {}) {
    if (!this.db) return { items: [], total: 0, has_more: false };
    const rawLimit = Number(query.limit);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(200, rawLimit) : 50;
    const where = [];
    const args = [];

    const status = String(query.status || "").trim().toLowerCase();
    if (status) {
      if (status === "ok" || status === "2xx") where.push("status >= 200 AND status < 300");
      else if (status === "4xx") where.push("status >= 400 AND status < 500");
      else if (status === "5xx") where.push("status >= 500");
      else if (status === "failed" || status === "err" || status === "error") where.push("(failed = 1 OR status >= 400)");
      else if (/^\d{3}$/.test(status)) { where.push("status = ?"); args.push(Number(status)); }
    }
    const issue = String(query.issue || "").trim();
    if (issue) {
      if (issue === "any") where.push("issue != ''");
      else if (issue === "none") where.push("issue = ''");
      else { where.push("issue = ?"); args.push(issue); }
    }
    const model = String(query.model || "").trim();
    if (model) { where.push("(model = ? OR served_model = ?)"); args.push(model, model); }
    const account = String(query.account || "").trim();
    if (account) { where.push("account = ?"); args.push(account); }
    const finish = String(query.finish || "").trim();
    if (finish) { where.push("finish_reason = ?"); args.push(finish); }
    const tools = String(query.tools || "").trim().toLowerCase();
    if (tools === "1" || tools === "true") where.push("tool_call_count > 0");
    else if (tools === "0" || tools === "false") where.push("tool_call_count = 0");
    const reqPath = String(query.path || "").trim();
    if (reqPath) { where.push("path LIKE ?"); args.push(reqPath + "%"); }
    const q = String(query.q || "").trim();
    if (q) {
      const like = `%${q}%`;
      where.push("(request_preview LIKE ? OR reply_preview LIKE ? OR error_preview LIKE ? OR model LIKE ? OR path LIKE ? OR req_id LIKE ? OR client_ip LIKE ? OR account LIKE ?)");
      args.push(like, like, like, like, like, like, like, like);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS c FROM audit_meta ${whereClause}`).get(...args)?.c ?? 0);

    const beforeId = Number(query.before_id);
    const afterId = Number(query.after_id);
    const pageWhere = [...where];
    const pageArgs = [...args];
    let orderBy = "ORDER BY id DESC";
    let reverse = false;
    if (Number.isInteger(beforeId) && beforeId > 0) {
      pageWhere.push("id < ?");
      pageArgs.push(beforeId);
    } else if (Number.isInteger(afterId) && afterId > 0) {
      pageWhere.push("id > ?");
      pageArgs.push(afterId);
      orderBy = "ORDER BY id ASC";
      reverse = true;
    }
    const pageWhereClause = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";
    pageArgs.push(limit + 1);
    const rows = this.db.prepare(`SELECT * FROM audit_meta ${pageWhereClause} ${orderBy} LIMIT ?`).all(...pageArgs);
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    if (reverse) sliced.reverse();
    return { items: sliced, total, has_more: hasMore };
  }

  get(id) {
    if (!this.db) return null;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return null;
    const meta = this.db.prepare("SELECT * FROM audit_meta WHERE id = ?").get(numId);
    if (!meta) return null;
    const body = this.db.prepare("SELECT * FROM audit_body WHERE id = ?").get(numId) || {};
    return { ...meta, ...body };
  }

  remove(id) {
    if (!this.db) return false;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM audit_body WHERE id = ?").run(numId);
      const res = this.db.prepare("DELETE FROM audit_meta WHERE id = ?").run(numId);
      this.db.exec("COMMIT");
      return Number(res.changes) > 0;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      return false;
    }
  }

  clear() {
    if (!this.db) return 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM audit_body").run();
      const res = this.db.prepare("DELETE FROM audit_meta").run();
      this.db.exec("COMMIT");
      return Number(res.changes);
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      return 0;
    }
  }

  prune() {
    if (!this.db) return;
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      this.db.exec("BEGIN");
      this.db.prepare("DELETE FROM audit_body WHERE id IN (SELECT id FROM audit_meta WHERE ts < ?)").run(cutoff);
      this.db.prepare("DELETE FROM audit_meta WHERE ts < ?").run(cutoff);
      const count = Number(this.db.prepare("SELECT COUNT(*) AS c FROM audit_meta").get()?.c ?? 0);
      if (count > this.maxRows) {
        const excess = count - this.maxRows;
        this.db.prepare("DELETE FROM audit_body WHERE id IN (SELECT id FROM audit_meta ORDER BY id ASC LIMIT ?)").run(excess);
        this.db.prepare("DELETE FROM audit_meta WHERE id IN (SELECT id FROM audit_meta ORDER BY id ASC LIMIT ?)").run(excess);
      }
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
    }
  }

  close() {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.db) { try { this.db.close(); } catch {} this.db = null; }
  }
}
