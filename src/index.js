// H+ STUDIO — Messenger bot (Cloudflare Workers + Claude API)
import { buildSystemPrompt, FALLBACK_REPLY, ATTACHMENT_REPLY, GREETING } from "./knowledge.js";

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
    // Nhân viên trả lời tay → bot tạm dừng với khách này
    const text = (msg.text || "").trim().toLowerCase();
    if (text === "#bot") {
      await env.BOT_KV.delete(`handoff:${customerId}`);
      return;
    }
    // Tin trả lời tự động của Meta (gửi vài giây sau tin khách) không phải người thật → bỏ qua
    const lastIn = Number(await env.BOT_KV.get(`lastin:${customerId}`) || 0);
    if (Date.now() - lastIn < AUTO_REPLY_WINDOW_MS) { L(env, "echo_auto_ignored"); return; }
    L(env, "echo_human_handoff");
    await setHandoff(env, customerId);
    return;
  }

  const psid = event.sender?.id;
  if (!psid) return;
  await env.BOT_KV.put(`lastin:${psid}`, String(Date.now()), { expirationTtl: 3600 });

  // Chống xử lý trùng khi Meta gửi lại
  if (msg.mid) {
    const seenKey = `mid:${msg.mid}`;
    if (await env.BOT_KV.get(seenKey)) { L(env, "skip_duplicate"); return; }
    await env.BOT_KV.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 });
  }

  // Đang có người thật phụ trách → bot im lặng
  if (await env.BOT_KV.get(`handoff:${psid}`)) { L(env, "skip_handoff"); return; }

  const text = (msg.text || "").trim();
  if (!text) {
    if (msg.attachments?.length) {
      await sendText(env, psid, ATTACHMENT_REPLY);
      await appendHistory(env, psid, [
        { role: "user", content: "[Khách gửi hình ảnh/file]" },
        { role: "assistant", content: ATTACHMENT_REPLY },
      ]);
      await notify(env, `📎 Khách vừa gửi hình/file trên Fanpage (PSID ${psid}). Vào hộp thư để xem.`);
    }
    return;
  }

  await senderAction(env, psid, "mark_seen");
  await senderAction(env, psid, "typing_on");

  const history = await loadHistory(env, psid);
  const isFirst = history.length === 0;
  history.push({ role: "user", content: text });

  // Tin đầu tiên của khách: luôn gửi lời chào cố định trước
  if (isFirst) {
    await sendText(env, psid, GREETING);
    L(env, "greeting");
  }

  let reply = null, handoffReason = null;
  try {
    const raw = await askClaude(env, history, isFirst);
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

  if (reply) await sendText(env, psid, reply);
  const said = [isFirst ? GREETING : null, reply].filter(Boolean).join("\n");
  if (said) history.push({ role: "assistant", content: said });
  await saveHistory(env, psid, history);

  if (handoffReason) {
    L(env, "handoff", handoffReason);
    await setHandoff(env, psid);
    await notify(env,
      `🔔 Khách Fanpage cần tư vấn viên\nLý do: ${handoffReason}\nTin cuối: "${text.slice(0, 300)}"\n` +
      `Trả lời tại: https://business.facebook.com/latest/inbox\n(Bot đã tạm dừng với khách này. Gõ #bot trong hội thoại để bật lại.)`);
  }
}

// ---------------------------------------------------------------------
async function askClaude(env, history, isFirst = false) {
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
      max_tokens: 600,
      system: buildSystemPrompt(now) + (isFirst ? FIRST_MESSAGE_NOTE : ""),
      messages: normalize(history),
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

const FIRST_MESSAGE_NOTE = `

# LƯU Ý CHO TIN NÀY
Đây là tin đầu tiên của khách. Hệ thống ĐÃ tự gửi lời chào: "${GREETING}"
- Nếu tin của khách chỉ là chào hỏi chung chung (ví dụ "chào shop", "hi", "alo", "tư vấn giúp"), chỉ trả về đúng [[KHONG_TRA_LOI]] và không viết gì khác.
- Nếu khách đã hỏi hoặc nêu nhu cầu cụ thể, KHÔNG chào lại, trả lời thẳng vào nội dung khách hỏi.`;

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
async function loadHistory(env, psid) {
  const raw = await env.BOT_KV.get(`hist:${psid}`);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function saveHistory(env, psid, history) {
  const trimmed = history.slice(-HISTORY_LIMIT);
  await env.BOT_KV.put(`hist:${psid}`, JSON.stringify(trimmed), { expirationTtl: HISTORY_TTL });
}

async function appendHistory(env, psid, items) {
  const h = await loadHistory(env, psid);
  h.push(...items);
  await saveHistory(env, psid, h);
}

async function setHandoff(env, psid) {
  const hours = Number(env.HANDOFF_HOURS || 12);
  await env.BOT_KV.put(`handoff:${psid}`, "1", { expirationTtl: Math.max(60, Math.round(hours * 3600)) });
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
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.error("notify error", e));
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

export const _test = { normalize, splitText, verifySignature };
