// H+ STUDIO — Messenger bot (Cloudflare Workers + Claude API)
import { buildSystemPrompt, FALLBACK_REPLY, ATTACHMENT_REPLY } from "./knowledge.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const HISTORY_LIMIT = 20;                 // số tin nhắn gần nhất gửi kèm cho Claude
const HISTORY_TTL = 60 * 60 * 24 * 14;    // giữ lịch sử hội thoại 14 ngày
const AUTO_REPLY_WINDOW_MS = 15000;       // tin Page gửi trong 15 giây sau tin khách = tự động, không tính là nhân viên
const HANDOFF_MARKER = /\[\[CHUYEN_NGUOI:?\s*([^\]]*)\]\]/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
      if (!ok) return new Response("Bad signature", { status: 401 });

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
      try {
        await handleEvent(event, env);
      } catch (e) {
        console.error("event error", e);
      }
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
    if (Date.now() - lastIn < AUTO_REPLY_WINDOW_MS) return;
    await setHandoff(env, customerId);
    return;
  }

  const psid = event.sender?.id;
  if (!psid) return;
  await env.BOT_KV.put(`lastin:${psid}`, String(Date.now()), { expirationTtl: 3600 });

  // Chống xử lý trùng khi Meta gửi lại
  if (msg.mid) {
    const seenKey = `mid:${msg.mid}`;
    if (await env.BOT_KV.get(seenKey)) return;
    await env.BOT_KV.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 });
  }

  // Đang có người thật phụ trách → bot im lặng
  if (await env.BOT_KV.get(`handoff:${psid}`)) return;

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
  history.push({ role: "user", content: text });

  let reply, handoffReason = null;
  try {
    const raw = await askClaude(env, history);
    const m = raw.match(HANDOFF_MARKER);
    if (m) handoffReason = (m[1] || "cần tư vấn viên").trim();
    reply = raw.replace(HANDOFF_MARKER, "").trim() || FALLBACK_REPLY;
  } catch (e) {
    console.error("claude error", e);
    reply = FALLBACK_REPLY;
    handoffReason = "Bot gặp lỗi khi gọi AI";
  }

  await sendText(env, psid, reply);
  history.push({ role: "assistant", content: reply });
  await saveHistory(env, psid, history);

  if (handoffReason) {
    await setHandoff(env, psid);
    await notify(env,
      `🔔 Khách Fanpage cần tư vấn viên\nLý do: ${handoffReason}\nTin cuối: "${text.slice(0, 300)}"\n` +
      `Trả lời tại: https://business.facebook.com/latest/inbox\n(Bot đã tạm dừng với khách này. Gõ #bot trong hội thoại để bật lại.)`);
  }
}

// ---------------------------------------------------------------------
async function askClaude(env, history) {
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
      system: buildSystemPrompt(now),
      messages: normalize(history),
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

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
    if (!res.ok) console.error("send error", res.status, await res.text());
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
