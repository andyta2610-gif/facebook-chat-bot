// Test giả lập: không gọi Facebook/Claude thật
import assert from "node:assert/strict";
import worker, { Conversation } from "../src/index.js";

// ---- KV giả ----
const kv = new Map();
const BOT_KV = {
  async get(k) { return kv.has(k) ? kv.get(k) : null; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
};

// ---- Durable Object giả ----
const objects = new Map(); // psid -> { obj, alarmAt }
function makeStorage(rec) {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { for (const x of [].concat(k)) m.delete(x); },
    async setAlarm(t) { rec.alarmAt = t; },
    _map: m,
  };
}
const env = {
  BOT_KV, APP_ID: "111", APP_SECRET: "secret", VERIFY_TOKEN: "vt",
  PAGE_ACCESS_TOKEN: "pat", ANTHROPIC_API_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tg", TELEGRAM_CHAT_ID: "1",
  DEBOUNCE_SECONDS: "8", MAX_WAIT_SECONDS: "30", TEST_PSIDS: "ADMIN",
  CONVO: {
    idFromName: (n) => n,
    get: (id) => {
      if (!objects.has(id)) {
        const rec = { alarmAt: null };
        rec.obj = new Conversation({ storage: makeStorage(rec) }, env);
        objects.set(id, rec);
      }
      const rec = objects.get(id);
      return { fetch: (url, init) => rec.obj.fetch(new Request(url, init)) };
    },
  },
};
async function fireAlarm(psid) {
  const rec = objects.get(psid);
  assert.ok(rec && rec.alarmAt, `phải có hẹn giờ trả lời cho ${psid}`);
  rec.alarmAt = null;
  await rec.obj.alarm();
}
const storageOf = (psid) => objects.get(psid).obj.storage._map;

// ---- fetch giả ----
let claudeReply = "Dạ chào anh/chị, em có thể giúp gì ạ?";
let claudeFails = false;
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (String(url).includes("anthropic")) {
    if (claudeFails) return new Response("overloaded", { status: 529 });
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
const echo = (psid, app_id, text, mid) => ({ object: "page", entry: [{ messaging: [{ sender: { id: "PAGE" }, recipient: { id: psid }, message: { is_echo: true, app_id, text, mid } }] }] });
const sentTexts = () => calls.filter((c) => c.url.includes("graph.facebook") && c.body?.message?.text).map((c) => c.body.message.text);
const claudeCalls = () => calls.filter((c) => c.url.includes("anthropic"));
const { GREETING: GREET, GREETING_INTRO: INTRO } = await import("../src/knowledge.js");

// 1. Xác minh webhook
let r = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc"), env, {});
assert.equal(await r.text(), "abc");
r = await worker.fetch(new Request("https://x/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc"), env, {});
assert.equal(r.status, 403);

// 2. Sai chữ ký bị chặn
r = await post(msgEvent("U1", "hi", "m0"), false);
assert.equal(r.status, 401);

// 3. Tin đầu tiên chỉ chào → chưa trả lời ngay; tới giờ hẹn mới gửi lời chào cố định
claudeReply = "[[KHONG_TRA_LOI]]";
r = await post(msgEvent("U1", "Chào shop", "m1"));
assert.equal(r.status, 200);
assert.equal(sentTexts().length, 0, "chưa trả lời khi khách có thể còn nhắn tiếp");
assert.ok(calls.some((c) => c.body?.sender_action === "typing_on"), "hiện đang soạn tin");
await fireAlarm("U1");
assert.deepEqual(sentTexts(), [GREET]);

// 3b. Khách mới nêu nhu cầu ngay tin đầu → 1 tin duy nhất: giới thiệu + câu trả lời
calls.length = 0;
claudeReply = "Dạ, bên em rất sẵn lòng được phục vụ anh/chị ạ.";
await post(msgEvent("U9", "Mình cần tư vấn thiết kế", "m90"));
await fireAlarm("U9");
assert.deepEqual(sentTexts(), [INTRO + "\n\nDạ, bên em rất sẵn lòng được phục vụ anh/chị ạ."]);

// 4. Khách nhắn liền 3 tin → bot gộp lại, gọi Claude 1 lần, trả lời 1 lần
calls.length = 0;
claudeReply = "Dạ căn hộ 70m2 ở Vũng Tàu phong cách Indochine bên em làm được ạ.";
await post(msgEvent("U1", "Mình cần thiết kế căn hộ", "m2"));
await post(msgEvent("U1", "70m2", "m3"));
await post(msgEvent("U1", "ở Vũng Tàu, thích Indochine", "m4"));
assert.equal(sentTexts().length, 0);
await fireAlarm("U1");
assert.equal(claudeCalls().length, 1, "chỉ gọi Claude 1 lần cho cả 3 tin");
const lastUser = claudeCalls()[0].body.messages.at(-1);
assert.equal(lastUser.role, "user");
assert.ok(lastUser.content.includes("70m2") && lastUser.content.includes("Indochine"), "Claude đọc đủ cả 3 tin");
assert.deepEqual(sentTexts(), ["Dạ căn hộ 70m2 ở Vũng Tàu phong cách Indochine bên em làm được ạ."]);
assert.deepEqual(claudeCalls()[0].body.messages.map((m) => m.role), ["user", "assistant", "user"]);

// 5. Meta gửi trùng → không xếp hàng lại
calls.length = 0;
await post(msgEvent("U1", "70m2", "m3"));
assert.equal(objects.get("U1").alarmAt, null, "tin trùng không tạo lượt trả lời mới");

// 6. Chuyển người: ẩn marker, báo Telegram, bot dừng
calls.length = 0;
claudeReply = "Dạ em đã chuyển cho kiến trúc sư ạ.\n[[CHUYEN_NGUOI: khách để lại SĐT]]";
await post(msgEvent("U1", "SĐT anh 0909xxxxxx", "m5"));
await fireAlarm("U1");
assert.deepEqual(sentTexts(), ["Dạ em đã chuyển cho kiến trúc sư ạ."]);
assert.ok(calls.some((c) => c.url.includes("telegram") && c.body.text.includes("khách để lại SĐT")));
calls.length = 0;
await post(msgEvent("U1", "Alo?", "m6"));
assert.equal(objects.get("U1").alarmAt, null, "bot phải im khi đang chuyển người");

// 7. Nhân viên gõ #bot → bot bật lại
await post(echo("U1", 999, "#bot", "e1"));
claudeReply = "Dạ em đây ạ.";
calls.length = 0;
await post(msgEvent("U1", "Còn ai không", "m7"));
await fireAlarm("U1");
assert.deepEqual(sentTexts(), ["Dạ em đây ạ."]);

// 8. Echo của chính bot không tắt bot; tin tự động của Meta ngay sau tin khách cũng không
await post(msgEvent("U2", "Chào", "m20"));
await post(echo("U2", 111, "bot msg", "e2"));
await post(echo("U2", 263902037430900, "Cảm ơn bạn đã nhắn tin", "e3"));
assert.equal(storageOf("U2").has("handoffUntil"), false, "tin tự động không được tắt bot");
// 8b. Nhân viên trả lời tay (1 phút sau) → bot dừng, huỷ hàng chờ
storageOf("U2").set("lastIn", Date.now() - 60000);
await post(echo("U2", 263902037430900, "Chào anh, em là KTS", "e4"));
assert.ok(storageOf("U2").get("handoffUntil") > Date.now());
calls.length = 0;
await objects.get("U2").obj.alarm();
assert.equal(sentTexts().length, 0, "nhân viên đã nhận khách thì bot không trả lời hàng chờ");

// 9. Gửi ảnh kèm chữ → Claude được xem ảnh, gộp 1 câu trả lời + báo anh
calls.length = 0;
claudeReply = "Dạ em thấy mặt bằng có phòng khách thông bếp ạ.";
storageOf("U1").set("hist", [{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "U1" }, recipient: { id: "PAGE" }, message: { mid: "m8", attachments: [{ type: "image", payload: { url: "https://cdn.fb/plan.jpg" } }] } }] }] });
await post(msgEvent("U1", "Đây là mặt bằng nhà mình", "m9"));
await fireAlarm("U1");
assert.deepEqual(sentTexts(), ["Dạ em thấy mặt bằng có phòng khách thông bếp ạ."]);
const lastMsg = claudeCalls().at(-1).body.messages.at(-1);
assert.equal(lastMsg.content[0].type, "image");
assert.equal(lastMsg.content[0].source.url, "https://cdn.fb/plan.jpg");
assert.ok(lastMsg.content.at(-1).text.includes("mặt bằng nhà mình"));
assert.ok(calls.some((c) => c.url.includes("telegram") && c.body.text.includes("hình/file")));
const savedHist = storageOf("U1").get("hist");
assert.ok(typeof savedHist.at(-2).content === "string" && savedHist.at(-2).content.includes("[Khách gửi 1 ảnh]"), "lịch sử chỉ lưu chữ, không lưu link ảnh");

// 9b. Chỉ gửi ảnh, không chữ → bot vẫn xem và nhận xét
calls.length = 0;
claudeReply = "Dạ đây là phong cách Indochine ạ.";
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "U1" }, recipient: { id: "PAGE" }, message: { mid: "m8b", attachments: [{ type: "image", payload: { url: "https://cdn.fb/mau.jpg" } }] } }] }] });
await fireAlarm("U1");
assert.deepEqual(sentTexts(), ["Dạ đây là phong cách Indochine ạ."]);

// 9c. Bấm 👍 / sticker / chỉ gửi icon → bot không trả lời, không gọi Claude
calls.length = 0;
await post({ object: "page", entry: [{ messaging: [{ sender: { id: "U1" }, recipient: { id: "PAGE" }, message: { mid: "m8c", sticker_id: 369239263222822, attachments: [{ type: "image", payload: { url: "https://cdn.fb/like.png", sticker_id: 369239263222822 } }] } }] }] });
await post(msgEvent("U1", "👍", "m8d"));
await post(msgEvent("U1", "😍😍 ", "m8e"));
await post(msgEvent("U1", ":)", "m8f"));
assert.equal(objects.get("U1").alarmAt, null, "không xếp hàng trả lời");
assert.equal(calls.length, 0, "không gửi gì, kể cả dấu đã xem");
// tin có chữ kèm icon vẫn trả lời bình thường
claudeReply = "Dạ vâng ạ.";
await post(msgEvent("U1", "Ok bạn 👍", "m8g"));
await fireAlarm("U1");
assert.deepEqual(sentTexts(), ["Dạ vâng ạ."]);

// 10. Lỗi Claude: khách mới vẫn có lời chào; khách cũ nhận câu dự phòng có hotline
claudeFails = true;
calls.length = 0;
await post(msgEvent("U3", "Báo giá giúp", "m30"));
await fireAlarm("U3");
assert.deepEqual(sentTexts(), [GREET]);
assert.ok(storageOf("U3").get("handoffUntil") > Date.now());
calls.length = 0;
await post(msgEvent("U1", "Báo giá giúp", "m10"));
await fireAlarm("U1");
assert.ok(sentTexts()[0].includes("0866625868"));

// 10b. Lệnh thử nghiệm: chỉ tài khoản quản trị dùng được
calls.length = 0;
await post(msgEvent("ADMIN", "Chào", "a1"));
await fireAlarm("ADMIN");
storageOf("ADMIN").set("handoffUntil", Date.now() + 3600000);
calls.length = 0;
await post(msgEvent("ADMIN", "#reset", "a2"));
assert.ok(sentTexts()[0].includes("Đã xoá lịch sử"));
assert.equal(storageOf("ADMIN").has("handoffUntil"), false);
assert.equal(storageOf("ADMIN").has("hist"), false);
calls.length = 0;
await post(msgEvent("U1", "#reset", "a3"));   // khách thường gõ #reset → coi như tin bình thường
assert.ok(!sentTexts().some((t) => t.includes("Thử nghiệm")));

// 11. Trang /status
r = await worker.fetch(new Request("https://x/status"), env, {});
const st = await r.json();
assert.equal(st.secrets.APP_SECRET, true);
assert.ok(st.trace.length > 0);

console.log("✅ Tất cả test đều đạt");
