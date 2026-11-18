// Test giả lập: không gọi Facebook/Claude thật
import assert from "node:assert/strict";
import worker from "../src/index.js";

const kv = new Map();
const BOT_KV = {
  async get(k) { return kv.has(k) ? kv.get(k) : null; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
};
const env = {
  BOT_KV, APP_ID: "111", APP_SECRET: "secret", VERIFY_TOKEN: "vt",
  PAGE_ACCESS_TOKEN: "pat", ANTHROPIC_API_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tg", TELEGRAM_CHAT_ID: "1",
};

let claudeReply = "Dạ chào anh/chị, em có thể giúp gì ạ?";
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (String(url).includes("anthropic")) {
    return new Response(JSON.stringify({ content: [{ type: "text", text: claudeReply }] }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};

async function sign(raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(payload, goodSig = true) {
  const raw = JSON.stringify(payload);
  const waits = [];
  const res = await worker.fetch(new Request("https://x/webhook", {
    method: "POST", body: raw,
    headers: { "x-hub-signature-256": goodSig ? await sign(raw) : "sha256=00" },
  }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}
const msgEvent = (psid, text, mid) => ({ object: "page", entry: [{ messaging: [{ sender: { id: psid }, recipient: { id: "PAGE" }, message: { mid, text } }] }] });
const sentTexts = () => calls.filter((c) => c.url.includes("graph.facebook") && c.body?.message?.text).map((c) => c.body.message.text);

// 1. Xác minh webhook
let r = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc"), env, {});
assert.equal(await r.text(), "abc");
r = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc"), env, {});
assert.equal(r.status, 403);

// 2. Sai chữ ký bị chặn
r = await post(msgEvent("U1", "hi", "m0"), false);
assert.equal(r.status, 401);

// 3. Tin nhắn thường → bot trả lời
r = await post(msgEvent("U1", "Chào shop", "m1"));
assert.equal(r.status, 200);
assert.deepEqual(sentTexts(), ["Dạ chào anh/chị, em có thể giúp gì ạ?"]);

// 4. Meta gửi trùng → không trả lời lần 2
calls.length = 0;
await post(msgEvent("U1", "Chào shop", "m1"));
assert.equal(sentTexts().length, 0);

// 5. Lịch sử được gửi kèm, xen kẽ đúng
calls.length = 0;
await post(msgEvent("U1", "Nhà phố 5x20 ở Thủ Đức", "m2"));
const claudeCall = calls.find((c) => c.url.includes("anthropic"));
assert.deepEqual(claudeCall.body.messages.map((m) => m.role), ["user", "assistant", "user"]);

// 6. Chuyển người: ẩn marker, báo Telegram, bot dừng
calls.length = 0;
claudeReply = "Dạ em đã chuyển cho kiến trúc sư ạ.\n[[CHUYEN_NGUOI: khách để lại SĐT]]";
await post(msgEvent("U1", "SĐT anh 0909xxxxxx", "m3"));
assert.deepEqual(sentTexts(), ["Dạ em đã chuyển cho kiến trúc sư ạ."]);
assert.ok(calls.some((c) => c.url.includes("telegram") && c.body.text.includes("khách để lại SĐT")));
calls.length = 0;
await post(msgEvent("U1", "Alo?", "m4"));
assert.equal(calls.filter((c) => c.url.includes("anthropic")).length, 0, "bot phải im khi đang chuyển người");

// 7. Nhân viên gõ #bot → bot bật lại
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "PAGE" }, recipient: { id: "U1" }, message: { is_echo: true, app_id: 999, text: "#bot", mid: "e1" } }] }] });
claudeReply = "Dạ em đây ạ.";
calls.length = 0;
await post(msgEvent("U1", "Còn ai không", "m5"));
assert.deepEqual(sentTexts(), ["Dạ em đây ạ."]);

// 8. Nhân viên tự trả lời tay → bot dừng với khách đó; echo của chính bot thì không
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "PAGE" }, recipient: { id: "U2" }, message: { is_echo: true, app_id: 111, text: "bot msg", mid: "e2" } }] }] });
assert.equal(kv.has("handoff:U2"), false);
// 8b. Tin tự động của Meta ngay sau tin khách → không tắt bot
await post(msgEvent("U2", "Chào", "m20"));
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "PAGE" }, recipient: { id: "U2" }, message: { is_echo: true, app_id: 263902037430900, text: "Cảm ơn bạn đã nhắn tin", mid: "e20" } }] }] });
assert.equal(kv.has("handoff:U2"), false, "tin tự động của Meta không được tắt bot");
kv.set("lastin:U2", String(Date.now() - 60000)); // giả lập 1 phút sau
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "PAGE" }, recipient: { id: "U2" }, message: { is_echo: true, app_id: 263902037430900, text: "Chào anh, em là KTS", mid: "e3" } }] }] });
assert.equal(kv.has("handoff:U2"), true);

// 9. Lỗi Claude → câu trả lời dự phòng + báo người
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  if (String(url).includes("anthropic")) return new Response("overloaded", { status: 529 });
  return new Response("{}", { status: 200 });
};
calls.length = 0;
await post(msgEvent("U3", "Báo giá giúp", "m6"));
assert.ok(sentTexts()[0].includes("0866625868"));
assert.equal(kv.has("handoff:U3"), true);

console.log("✅ Tất cả test đều đạt");
