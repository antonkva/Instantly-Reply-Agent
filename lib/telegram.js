const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const pendingDrafts = new Map();
let nextId = 1;

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export async function sendApprovalMessage(client, event, classification) {
  const id = String(nextId++);
  pendingDrafts.set(id, { client, event, classification, status: "pending" });

  const leadName = event.firstName || event.lead_email || "lead";
  const businessName = event["Business Name"] ?? event.companyName ?? "";

  const text =
    `*New reply — ${client.client_name}*\n` +
    `${leadName}${businessName ? ` (${businessName})` : ""}\n\n` +
    `*Their reply:*\n${truncate(event.reply_text_snippet, 500)}\n\n` +
    `*Intent:* ${classification.intent} (${Math.round(classification.confidence * 100)}%)\n\n` +
    `*Draft:*\n${classification.draft_reply}`;

  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Send", callback_data: `send:${id}` },
            { text: "✏️ Edit", callback_data: `edit:${id}` },
            { text: "🗑 Delete", callback_data: `delete:${id}` },
          ],
        ],
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }

  return id;
}

export async function sendNotification(text) {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

export async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`${API_BASE}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export function getPendingDraft(id) {
  return pendingDrafts.get(id);
}

export function updatePendingDraft(id, updates) {
  const draft = pendingDrafts.get(id);
  if (!draft) return null;
  Object.assign(draft, updates);
  return draft;
}

export function deletePendingDraft(id) {
  pendingDrafts.delete(id);
}
