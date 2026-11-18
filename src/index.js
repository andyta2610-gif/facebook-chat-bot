// H+ STUDIO — Messenger bot (Cloudflare Workers + Claude API)
import { PRIVACY_HTML } from "./privacy.js";
import { buildSystemPrompt, FALLBACK_REPLY, ATTACHMENT_REPLY, GREETING, GREETING_INTRO, FOLLOWUP_TEXT } from "./knowledge.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const HISTORY_LIMIT = 20;                 // số tin nhắn gần nhất gửi kèm cho Claude
const HISTORY_TTL = 60 * 60 * 24 * 14;    // giữ lịch sử hội thoại 14 ngày
const AUTO_REPLY_WINDOW_MS = 15000;       // tin Page gửi trong 15 giây sau tin khách = tự động, không tính là nhân viên
const SKIP_MARKER = /\[\[KHONG_TRA_LOI\]\]/i;
const HANDOFF_MARKER = /\[\[CHUYEN_NGUOI:?\s*([^\]]*)\]\]/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      // Nhật ký kỹ thuật gần nhất (không chứa nội dung tin nhắn hay khoá bí mật)
      const raw = await env.BOT_KV.get("trace");
      const status = {
        now: new Date().toISOString(),
        secrets: {
          ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
          PAGE_ACCESS_TOKEN: !!env.PAGE_ACCESS_TOKEN,
          APP_SECRET: !!env.APP_SECRET,
          VERIFY_TOKEN: !!env.VERIFY_TOKEN,
        },
        trace: raw ? JSON.parse(raw) : [],
      };
      return new Response(JSON.stringify(status, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/telegram/setup") {
      return new Response(await tgSetup(env), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      return tgWebhook(request, env);
    }
    if (url.pathname === "/zalo/setup") {
      return new Response(await zaloSetup(env, url.origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/zalo" && request.method === "POST") {
      return zaloWebhook(request, env);
    }
    if (url.pathname === "/privacy") {
      return new Response(PRIVACY_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname !== "/webhook") {
      return new Response("H+ STUDIO bot đang chạy.", { status: 200 });
    }

    // Bước xác minh webhook của Meta
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST") {
      const raw = await request.text();
      const ok = await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.APP_SECRET);
      if (!ok) {
        ctx.waitUntil(saveTrace(env, [{ t: Date.now(), s: "bad_signature" }]));
        return new Response("Bad signature", { status: 401 });
      }

      let body;
      try { body = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }
      if (body.object !== "page") return new Response("ignored", { status: 200 });

      // Trả 200 ngay cho Meta, xử lý phía sau
      ctx.waitUntil(processEntries(body.entry || [], env).catch((e) => console.error("process error", e)));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

// ---------------------------------------------------------------------
async function processEntries(entries, env) {
  for (const entry of entries) {
    for (const event of entry.messaging || []) {
      const tr = [];
      const log = (stage, detail) => tr.push({ t: Date.now(), s: stage, ...(detail ? { d: String(detail).slice(0, 300) } : {}) });
      env.__log = log;
      log("event", event.message?.is_echo ? `echo app=${event.message.app_id}` : `from=..${String(event.sender?.id || "").slice(-4)}`);
      try {
        await handleEvent(event, env);
      } catch (e) {
        console.error("event error", e);
        log("error", e?.message || e);
      }
      await saveTrace(env, tr).catch(() => {});
    }
  }
}

async function handleEvent(event, env) {
  const msg = event.message;
  if (!msg) return; // bỏ qua delivery/read/postback...

  // Tin do Page gửi đi (echo)
  if (msg.is_echo) {
    const customerId = event.recipient?.id;
    const fromOurBot = String(msg.app_id || "") === String(env.APP_ID || "");
    if (!customerId || fromOurBot) return;
    const r = await convo(env, customerId).fetch("https://do/echo", {
      method: "POST", body: JSON.stringify({ text: msg.text || "" }),
    });
    L(env, "echo", await r.text());
    return;
  }

  const psid = event.sender?.id;
  if (!psid) return;

  let text = (msg.text || "").trim();
  // Sticker (kể cả nút 👍 Like) không phải ảnh thật
  const isSticker = (a) => !!(a.payload?.sticker_id);
  const stickerIds = [msg.sticker_id, ...(msg.attachments || []).map((a) => a.payload?.sticker_id)].filter(Boolean).map(String);
  const atts = (msg.attachments || []).filter((a) => !isSticker(a) && a.type !== "fallback");
  // Chỉ bấm Like, gửi sticker hoặc toàn icon/emoji → bot không trả lời
  if (isOnlyEmoji(text)) text = "";
  if (!text && !atts.length) { if (stickerIds.length || msg.text) L(env, "skip_icon"); return; }
  const images = atts.filter((a) => a.type === "image" && a.payload?.url).map((a) => a.payload.url).slice(0, 5);
  const otherFiles = atts.some((a) => a.type !== "image");
  if (!text && !atts.length) return;

  // Khách yêu cầu xoá dữ liệu (cam kết trong Chính sách quyền riêng tư)
  const norm = text.toLowerCase().normalize("NFC");
  if (/^(xin\s+|vui lòng\s+|hãy\s+)?(xoá|xóa)\s+dữ\s+liệu|^delete my data/.test(norm)) {
    await convo(env, psid).fetch("https://do/admin", { method: "POST", body: JSON.stringify({ cmd: "#reset" }) });
    L(env, "data_deleted");
    await sendText(env, psid, "Dạ, em đã xoá toàn bộ lịch sử trò chuyện của anh/chị trên hệ thống trợ lý tự động của H+ studio. Nếu cần hỗ trợ thêm, anh/chị gọi hotline 0866.625.868 ạ.");
    await notify(env, "🗑 Một khách trên Fanpage vừa yêu cầu xoá dữ liệu. Bot đã xoá lịch sử trò chuyện; nếu có lưu thông tin khách ở nơi khác (sổ, Excel...) xin xoá giúp.");
    return;
  }

  // Lệnh thử nghiệm dành cho tài khoản quản trị (TEST_PSIDS): #reset, #bot
  const admins = String(env.TEST_PSIDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const cmd = text.toLowerCase();
  if (admins.includes(String(psid)) && (cmd === "#reset" || cmd === "#bot")) {
    await convo(env, psid).fetch("https://do/admin", { method: "POST", body: JSON.stringify({ cmd }) });
    L(env, "admin_" + cmd.slice(1));
    await sendText(env, psid, cmd === "#reset"
      ? "[Thử nghiệm] Đã xoá lịch sử và bật lại bot. Tin tiếp theo sẽ được xử lý như khách mới."
      : "[Thử nghiệm] Đã bật lại bot cho hội thoại này.");
    return;
  }
  const item = { ...(text ? { text } : {}), ...(images.length ? { images } : {}), ...(otherFiles ? { attach: true } : {}) };

  // Đưa tin vào hàng chờ; bot sẽ trả lời gộp khi khách ngừng nhắn
  const r = await convo(env, psid).fetch("https://do/add", {
    method: "POST", body: JSON.stringify({ psid, mid: msg.mid, item }),
  });
  const status = await r.text();
  L(env, status);
  if (status === "queued") {
    await senderAction(env, psid, "mark_seen");
    await senderAction(env, psid, "typing_on");
  }
}

function isOnlyEmoji(t) {
  if (!t) return false;
  // Chỉ xoá ký tự hình ảnh thật sự; chữ số, chữ cái giữ nguyên (số điện thoại không bị coi là icon)
  const stripped = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3\s]/gu, "")
    .replace(/[:;=][-']?[)(DPpOo3]|<3|\^_?\^/g, "");
  return stripped.length === 0;
}

function convo(env, psid) {
  return env.CONVO.get(env.CONVO.idFromName(String(psid)));
}

// =====================================================================
//  Mỗi khách có một "Conversation" riêng: giữ lịch sử, hàng chờ tin nhắn,
//  trạng thái chuyển người thật. Bot chờ khách ngừng nhắn rồi trả lời 1 lần.
// =====================================================================
export class Conversation {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const st = this.storage;
    const now = Date.now();

    if (url.pathname === "/add") {
      // Chống trùng khi Meta gửi lại
      const mids = (await st.get("mids")) || [];
      if (body.mid && mids.includes(body.mid)) return new Response("skip_duplicate");
      if (body.mid) await st.put("mids", [...mids, body.mid].slice(-50));

      await st.put("psid", body.psid);
      await st.put("lastIn", now);
      if (((await st.get("handoffUntil")) || 0) > now) return new Response("skip_handoff");

      await st.delete("followUpAt");   // khách đã nhắn lại → huỷ nhắc
      const pending = (await st.get("pending")) || [];
      pending.push(body.item);
      await st.put("pending", pending);
      let firstAt = await st.get("firstAt");
      if (!firstAt) { firstAt = now; await st.put("firstAt", firstAt); }

      const wait = Number(this.env.DEBOUNCE_SECONDS || 8) * 1000;
      const maxWait = Number(this.env.MAX_WAIT_SECONDS || 30) * 1000;
      await st.setAlarm(Math.min(now + wait, firstAt + maxWait));
      return new Response("queued");
    }

    if (url.pathname === "/admin") {
      await st.delete(["handoffUntil", "pending", "firstAt"]);
      await st.delete("followUpAt");
      if (body.cmd === "#reset") await st.delete(["hist", "lastReplyAt", "followUpDone"]);
      return new Response("ok");
    }

    if (url.pathname === "/echo") {
      const text = String(body.text || "").trim().toLowerCase();
      if (text === "#bot") { await st.delete("handoffUntil"); return new Response("bot_resumed"); }
      // Tin tự động của Meta (vài giây sau tin khách) không phải người thật
      if (now - ((await st.get("lastIn")) || 0) < AUTO_REPLY_WINDOW_MS) return new Response("echo_auto_ignored");
      await this.setHandoff();
      await st.delete(["pending", "firstAt"]);
      return new Response("echo_human_handoff");
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const st = this.storage;
    const pending = (await st.get("pending")) || [];
    const psid = await st.get("psid");
    await st.delete(["pending", "firstAt"]);
    if (!psid) return;
    const followUpAt = (await st.get("followUpAt")) || 0;
    if (!pending.length && !(followUpAt && followUpAt <= Date.now() + 1000)) return;

    const tr = [];
    this.env.__log = (stage, detail) => tr.push({ t: Date.now(), s: stage, ...(detail ? { d: String(detail).slice(0, 300) } : {}) });
    try {
      if (((await st.get("handoffUntil")) || 0) > Date.now()) L(this.env, "skip_handoff");
      else if (pending.length) { L(this.env, "reply_batch", `${pending.length} tin`); await this.reply(psid, pending); }
      else await this.followUp(psid);
    } catch (e) {
      console.error("reply error", e);
      L(this.env, "error", e?.message || e);
    }
    await saveTrace(this.env, tr).catch(() => {});
  }

  async setHandoff() {
    const hours = Number(this.env.HANDOFF_HOURS || 12);
    await this.storage.put("handoffUntil", Date.now() + hours * 3600 * 1000);
  }

  async reply(psid, pending) {
    const env = this.env, st = this.storage;
    const texts = pending.filter((x) => x.text).map((x) => x.text);
    const images = pending.flatMap((x) => x.images || []).slice(0, 5);
    const hasAttach = pending.some((x) => x.attach);

    // Lịch sử: quên hội thoại cũ hơn 14 ngày (khách quay lại sẽ được chào lại)
    let history = (await st.get("hist")) || [];
    if (now() - ((await st.get("lastReplyAt")) || 0) > HISTORY_TTL * 1000) history = [];
    const isFirst = history.length === 0;

    // Chỉ gửi file (không phải ảnh), không có chữ
    if (!texts.length && !images.length) {
      await sendText(env, psid, ATTACHMENT_REPLY);
      history.push({ role: "user", content: "[Khách gửi hình ảnh/file]" }, { role: "assistant", content: ATTACHMENT_REPLY });
      await this.saveHistory(history);
      await notify(env, `📎 Khách vừa gửi hình/file trên Fanpage. Vào hộp thư để xem: https://business.facebook.com/latest/inbox`);
      return;
    }

    const notes = [];
    if (images.length) notes.push(`[Khách gửi ${images.length} ảnh]`);
    if (hasAttach) notes.push("[Khách có gửi kèm file/video]");
    const userText = [texts.join("\n"), ...notes].filter(Boolean).join("\n");
    history.push({ role: "user", content: userText });

    let reply = null, handoffReason = null;
    try {
      let raw;
      try {
        raw = await askClaude(env, history, isFirst, images);
      } catch (e) {
        if (!images.length) throw e;
        L(env, "image_error", e?.message);   // không đọc được ảnh → trả lời theo chữ
        raw = await askClaude(env, history, isFirst);
      }
      L(env, "claude_ok");
      const m = raw.match(HANDOFF_MARKER);
      if (m) handoffReason = (m[1] || "cần tư vấn viên").trim();
      if (SKIP_MARKER.test(raw)) reply = null;   // khách chỉ chào hỏi → lời chào là đủ
      else reply = raw.replace(HANDOFF_MARKER, "").trim() || (isFirst ? null : FALLBACK_REPLY);
    } catch (e) {
      console.error("claude error", e);
      L(env, "claude_error", e?.message);
      reply = isFirst ? null : FALLBACK_REPLY;
      handoffReason = "Bot gặp lỗi khi gọi AI";
    }

    // Tin đầu: chỉ chào → lời chào đầy đủ; đã có nhu cầu → giới thiệu + câu trả lời gộp thành 1 tin
    let said = reply;
    if (isFirst) {
      said = reply ? `${GREETING_INTRO}\n\n${reply}` : GREETING;
      L(env, "greeting");
    }
    if (said) await sendText(env, psid, said);
    if (said) history.push({ role: "assistant", content: said });
    await this.saveHistory(history);

    if (hasAttach || images.length) await notify(env, `📎 Khách vừa gửi hình/file trên Fanpage. Vào hộp thư để xem: https://business.facebook.com/latest/inbox`);
    // Hẹn nhắc khách 1 lần nếu khách im lặng (chỉ khi chưa chuyển người)
    if (!handoffReason && said && !(await st.get("followUpDone"))) {
      const at = now() + Number(env.FOLLOWUP_MINUTES || 5) * 60 * 1000;
      await st.put("followUpAt", at);
      await st.setAlarm(at);
    }

    if (handoffReason) {
      L(env, "handoff", handoffReason);
      await this.setHandoff();
      const said = history.filter((h) => h.role === "user").map((h) => `- ${h.content}`).join("\n").slice(-1200);
      await notify(env,
        `🔔 KHÁCH FANPAGE CẦN KTS LIÊN HỆ\nLý do: ${handoffReason}\n\nKhách đã nhắn:\n${said}\n\n` +
        `Xem hội thoại: https://business.facebook.com/latest/inbox\n(Bot đã tạm dừng với khách này. Gõ #bot trong hội thoại để bật lại.)`);
    }
  }

  // Khách im lặng sau câu hỏi của bot → nhắc 1 lần (nếu chưa biết loại công trình)
  async followUp(psid) {
    const env = this.env, st = this.storage;
    await st.delete("followUpAt");
    await st.put("followUpDone", true);
    const history = (await st.get("hist")) || [];
    if (!history.length) return;
    const raw = await askClaude(env, [...history, { role: "user", content: FOLLOWUP_PROBE }]);
    if (SKIP_MARKER.test(raw) || !raw.trim()) { L(env, "followup_skip"); return; }
    const text = raw.replace(HANDOFF_MARKER, "").trim();
    await sendText(env, psid, text);
    L(env, "followup_sent");
    history.push({ role: "assistant", content: text });
    await this.saveHistory(history);
  }

  async saveHistory(history) {
    await this.storage.put("hist", history.slice(-HISTORY_LIMIT));
    await this.storage.put("lastReplyAt", now());
  }
}

function now() { return Date.now(); }

// ---------------------------------------------------------------------
async function askClaude(env, history, isFirst = false, images = []) {
  const messages = normalize(history);
  if (images.length && messages.length) {
    const last = messages[messages.length - 1];
    last.content = [
      ...images.map((url) => ({ type: "image", source: { type: "url", url } })),
      { type: "text", text: last.content },
    ];
  }
  const now = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 2500,
      system: buildSystemPrompt(now) + (isFirst ? FIRST_MESSAGE_NOTE : ""),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  // Lỡ bị cắt giữa chừng → bỏ phần dở dang, giữ đến câu/dòng hoàn chỉnh cuối cùng
  if (data.stop_reason === "max_tokens") text = trimToComplete(text);
  return text;
}

function trimToComplete(text) {
  const lastLine = text.lastIndexOf("\n");
  const lastSentence = Math.max(text.lastIndexOf(". "), text.lastIndexOf("? "), text.lastIndexOf("! "), text.lastIndexOf("ạ."));
  const cut = Math.max(lastLine, lastSentence + 1);
  return cut > text.length * 0.5 ? text.slice(0, cut).trim() : text;
}

const FIRST_MESSAGE_NOTE = `

# LƯU Ý CHO TIN NÀY
Đây là tin đầu tiên của khách. Hệ thống sẽ tự đặt câu giới thiệu này lên ĐẦU câu trả lời của bạn: "${GREETING_INTRO}"
- Nếu tin của khách chỉ là chào hỏi chung chung (ví dụ "chào shop", "hi", "alo", "có ai không"), chỉ trả về đúng [[KHONG_TRA_LOI]] và không viết gì khác (hệ thống sẽ gửi lời chào đầy đủ).
- Nếu khách đã nêu nhu cầu (kể cả chung chung như "cần tư vấn thiết kế"), KHÔNG chào lại, KHÔNG giới thiệu lại, chỉ viết phần trả lời tiếp nối câu giới thiệu.`;

const FOLLOWUP_PROBE = `[THÔNG BÁO HỆ THỐNG, không phải lời khách: khách chưa trả lời tin nhắn gần nhất của bạn một lúc rồi.]
- Nếu trong hội thoại khách CHƯA cho biết loại công trình (nhà phố, biệt thự, căn hộ...), trả lời đúng nguyên văn: "${FOLLOWUP_TEXT}"
- Nếu khách đã cho biết loại công trình rồi, chỉ trả về đúng [[KHONG_TRA_LOI]].`;

// Claude yêu cầu tin nhắn xen kẽ user/assistant và bắt đầu bằng user
function normalize(history) {
  const out = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// ---------------------------------------------------------------------
async function sendText(env, psid, text) {
  for (const part of splitText(text, 1900)) {
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: part } }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("send error", res.status, err);
      L(env, "send_error", `${res.status} ${err}`);
    } else L(env, "sent");
  }
}

async function senderAction(env, psid, action) {
  await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(env.PAGE_ACCESS_TOKEN)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: { id: psid }, sender_action: action }),
  }).catch(() => {});
}

function splitText(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function L(env, stage, detail) { try { env.__log && env.__log(stage, detail); } catch {} }

async function saveTrace(env, items) {
  if (!items.length) return;
  let arr = [];
  try { arr = JSON.parse((await env.BOT_KV.get("trace")) || "[]"); } catch {}
  arr.push(items);
  await env.BOT_KV.put("trace", JSON.stringify(arr.slice(-15)), { expirationTtl: 60 * 60 * 24 * 3 });
}

// Báo cho anh qua Telegram (không bắt buộc)
async function notify(env, text) {
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN) {
    const chatId = env.TELEGRAM_CHAT_ID || (await env.BOT_KV.get("tg_chat_id"));
    if (chatId) jobs.push(tgSend(env, chatId, text));
    else L(env, "telegram_not_linked");
  }
  if (env.ZALO_BOT_TOKEN) {
    const chatId = env.ZALO_CHAT_ID || (await env.BOT_KV.get("zalo_chat_id"));
    if (chatId) jobs.push(zaloSend(env, chatId, text));
    else L(env, "zalo_not_linked");
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("notify error", r.reason);
  if (jobs.length) L(env, "notified");
}

// ---------------------------------------------------------------------
//  Telegram: báo cho anh qua Telegram
// ---------------------------------------------------------------------
async function tgSend(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!res.ok) L(env, "telegram_error", `${res.status} ${await res.text()}`);
  return res;
}

async function tgSecret(env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.APP_SECRET || ""}:tg-webhook`));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// Mở /telegram/setup sau khi đã bấm Start trong bot Telegram → tìm chat của anh và liên kết
async function tgSetup(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return "Chưa có TELEGRAM_BOT_TOKEN. Hãy thêm mã bot Telegram vào Cloudflare (Secret) rồi mở lại trang này.";
  const api = (m) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`;
  let name = "";
  try {
    const me = await (await fetch(api("getMe"))).json();
    if (!me.ok) return `❌ Token Telegram không đúng: ${me.description || ""}`;
    name = me.result?.username ? `@${me.result.username}` : "";
  } catch (e) { return `❌ Không gọi được Telegram: ${e?.message || e}`; }

  const linked = await env.BOT_KV.get("tg_chat_id");
  if (linked) return `✅ Telegram ${name} đã được liên kết. Thông báo khách mới sẽ gửi về đó.`;

  await fetch(api("deleteWebhook"), { method: "POST" }).catch(() => {});
  const up = await (await fetch(api("getUpdates"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowed_updates: ["message"] }),
  })).json().catch(() => ({}));
  const msgs = (up.result || []).map((u) => u.message).filter((m) => m?.chat?.type === "private");
  if (!msgs.length) return `Gần xong rồi! Mở Telegram, vào bot ${name}, bấm Start (hoặc nhắn /start), rồi mở lại trang này.`;
  const chat = msgs[0].chat;
  await env.BOT_KV.put("tg_chat_id", String(chat.id));
  await tgSend(env, chat.id, "✅ Đã liên kết! Từ giờ khi khách trên Fanpage H+ studio để lại số điện thoại hoặc cần người tư vấn, em sẽ báo anh ở đây.");
  return `✅ Đã liên kết Telegram ${name} với tài khoản ${chat.first_name || ""} ${chat.last_name || ""}. Anh kiểm tra Telegram sẽ thấy tin xác nhận.`;
}

// Anh nhắn cho bot Telegram → liên kết tài khoản nhận thông báo (chỉ người đầu tiên)
async function tgWebhook(request, env) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== (await tgSecret(env))) return new Response("Forbidden", { status: 403 });
  const body = await request.json().catch(() => ({}));
  const chatId = body.message?.chat?.id;
  if (!chatId) return new Response("ok");
  const linked = await env.BOT_KV.get("tg_chat_id");
  if (!linked) {
    await env.BOT_KV.put("tg_chat_id", String(chatId));
    await tgSend(env, chatId, "✅ Đã liên kết! Từ giờ khi khách trên Fanpage H+ studio để lại số điện thoại hoặc cần người tư vấn, em sẽ báo anh ở đây.");
  } else if (linked === String(chatId)) {
    await tgSend(env, chatId, "Tài khoản này đang nhận thông báo từ bot Fanpage H+ studio ạ.");
  } else {
    await tgSend(env, chatId, "Bot này đã được liên kết với một tài khoản khác.");
  }
  return new Response("ok");
}

// ---------------------------------------------------------------------
//  Zalo Bot: báo cho anh qua Zalo
// ---------------------------------------------------------------------
const ZALO_API = "https://bot-api.zaloplatforms.com";

async function zaloSend(env, chatId, text) {
  const res = await fetch(`${ZALO_API}/bot${env.ZALO_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: String(chatId), text: text.slice(0, 1990) }),
  });
  if (!res.ok) L(env, "zalo_error", `${res.status} ${await res.text()}`);
  return res;
}

async function zaloSecret(env) {
  const data = new TextEncoder().encode(`${env.APP_SECRET || ""}:zalo-webhook`);
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// Mở /zalo/setup một lần để Zalo gửi tin nhắn về bot
async function zaloSetup(env, origin) {
  if (!env.ZALO_BOT_TOKEN) return "Chưa có ZALO_BOT_TOKEN. Hãy thêm mã Zalo Bot vào Cloudflare (Secret) rồi mở lại trang này.";
  const res = await fetch(`${ZALO_API}/bot${env.ZALO_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${origin}/zalo`, secret_token: await zaloSecret(env) }),
  });
  const body = await res.text();
  let ok = res.ok;
  try { ok = ok && JSON.parse(body).ok !== false; } catch {}
  const linked = await env.BOT_KV.get("zalo_chat_id");
  return ok
    ? `✅ Đã kết nối Zalo Bot.\n${linked ? "Tài khoản Zalo nhận thông báo đã được liên kết." : "Bước cuối: mở Zalo, nhắn một tin bất kỳ (ví dụ: xin chào) cho Zalo Bot vừa tạo để liên kết tài khoản nhận thông báo."}`
    : `❌ Zalo báo lỗi: ${body.slice(0, 300)}`;
}

// Zalo gửi tin nhắn về (anh nhắn cho Zalo Bot) → liên kết tài khoản nhận thông báo
async function zaloWebhook(request, env) {
  if (request.headers.get("x-bot-api-secret-token") !== (await zaloSecret(env))) return new Response("Forbidden", { status: 403 });
  const body = await request.json().catch(() => ({}));
  const m = body.result?.message || body.message;
  const chatId = m?.chat?.id;
  if (!chatId) return new Response("ok");
  const linked = await env.BOT_KV.get("zalo_chat_id");
  if (!linked) {
    await env.BOT_KV.put("zalo_chat_id", String(chatId));
    await zaloSend(env, chatId, "✅ Đã liên kết! Từ giờ khi khách trên Fanpage H+ studio để lại số điện thoại hoặc cần người tư vấn, em sẽ báo anh ở đây.");
  } else if (linked === String(chatId)) {
    await zaloSend(env, chatId, "Tài khoản này đang nhận thông báo từ bot Fanpage H+ studio ạ.");
  } else {
    await zaloSend(env, chatId, "Bot này đã được liên kết với một tài khoản khác.");
  }
  return new Response("ok");
}

// ---------------------------------------------------------------------
async function verifySignature(raw, header, secret) {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export const _test = { normalize, splitText, verifySignature, trimToComplete, isOnlyEmoji };
