import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore, sanitizeBase64, sanitizeHeaders, extractRequestPreview } from "../src/gateway/audit-store.mjs";

test("AuditStore records, sanitizes, filters, paginates, gets, deletes, and clears", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gapp-audit-test-"));
  const store = new AuditStore(dir, { retentionDays: 7 });
  try {
    const id1 = store.record({
      reqId: "req_1",
      ts: Date.now() - 2000,
      clientIp: "1.2.3.4",
      method: "POST",
      path: "/v1/chat/completions",
      model: "gemini-neon",
      servedModel: "Gemini 4 Neon",
      stream: true,
      status: 200,
      failed: false,
      ttfbMs: 120,
      totalMs: 450,
      promptTokens: 20,
      outputTokens: 35,
      totalTokens: 55,
      toolCallCount: 0,
      attempts: 1,
      account: "user@example.com",
      keyFp: "key_1",
      issue: "",
      finishReason: "stop",
      requestBody: {
        model: "gemini-neon",
        messages: [
          { role: "user", content: [{ type: "text", text: "Hello audit" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } }] },
        ],
      },
      reply: "Audit reply text",
      toolCalls: [],
      reqHeaders: { authorization: "Bearer secret-key", cookie: "sid=abc", "user-agent": "test-client" },
    });
    const id2 = store.record({
      reqId: "req_2",
      ts: Date.now() - 1000,
      clientIp: "5.6.7.8",
      method: "POST",
      path: "/v1/responses",
      model: "gemini-hydrogen",
      stream: false,
      status: 429,
      failed: true,
      ttfbMs: 80,
      totalMs: 80,
      toolCallCount: 1,
      attempts: 2,
      account: "user2@example.com",
      keyFp: "key_2",
      issue: "NATIVE_QUOTA_EXHAUSTED",
      finishReason: "error",
      requestBody: { model: "gemini-hydrogen", input: "Run tool check" },
      reply: "",
      toolCalls: [{ name: "get_weather", arguments: "{}" }],
      error: { code: "NATIVE_QUOTA_EXHAUSTED", message: "Quota hit" },
      errorCode: "NATIVE_QUOTA_EXHAUSTED",
    });

    assert.ok(id1 > 0 && id2 > id1);

    const facets = store.facets();
    assert.deepEqual(facets.models, ["gemini-hydrogen", "gemini-neon"]);
    assert.deepEqual(facets.accounts, ["user2@example.com", "user@example.com"]);
    assert.deepEqual(facets.issues, ["NATIVE_QUOTA_EXHAUSTED"]);
    assert.equal(facets.total_count, 2);
    assert.ok(facets.size_bytes > 0);

    const all = store.list({ limit: 1 });
    assert.equal(all.total, 2);
    assert.equal(all.items.length, 1);
    assert.equal(all.items[0].id, id2);
    assert.equal(all.has_more, true);

    const next = store.list({ limit: 1, before_id: all.items[0].id });
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].id, id1);
    assert.equal(next.has_more, false);

    assert.equal(store.list({ status: "ok" }).total, 1);
    assert.equal(store.list({ status: "failed" }).total, 1);
    assert.equal(store.list({ tools: "1" }).total, 1);
    assert.equal(store.list({ q: "Hello audit" }).total, 1);

    const detail = store.get(id1);
    assert.equal(detail.reply, "Audit reply text");
    assert.ok(!detail.request_body.includes("iVBORw0KGgo"));
    assert.ok(detail.request_body.includes("redacted"));
    const headers = JSON.parse(detail.req_headers);
    assert.equal(headers.authorization, "[REDACTED]");
    assert.equal(headers.cookie, "[REDACTED]");
    assert.equal(headers["user-agent"], "test-client");

    assert.equal(store.remove(id1), true);
    assert.equal(store.get(id1), null);
    assert.equal(store.clear(), 1);
    assert.equal(store.list().total, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AuditStore helpers sanitize base64, headers, and extract previews", () => {
  assert.ok(sanitizeBase64("data:image/jpeg;base64,AAAA==").includes("redacted"));
  assert.equal(sanitizeHeaders({ Authorization: "Bearer x", "X-Test": "ok" }).authorization, "[REDACTED]");
  assert.equal(extractRequestPreview({ messages: [{ role: "user", content: "first" }, { role: "assistant", content: "mid" }, { role: "user", content: "latest" }] }), "latest");
});
