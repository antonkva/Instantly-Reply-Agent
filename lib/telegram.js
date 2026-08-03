const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// In-memory store of pending drafts, keyed by a short id referenced in
// button callback_data. This does NOT survive a server restart — Render's
// free tier can spin down after inactivity, which would lose anything
// still pending approval. Fine for testing; worth moving to a persistent
// store (e.g. a Pending table in Airtable) before relying on this in
// production with real client sends on the line.
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
    `New reply — ${client.client_name}\n` +
    `${leadName}${businessName ? ` (${businessName})` : ""}\n\n` +
    `Their reply:\n${truncate(event.reply_text_snippet, 500)}\n\n` +
    `Intent: ${classification.intent} (${Math.round(classification.confidence * 100)}%)\n\n` +
    `Draft:\n${classification.draft_reply}`;

  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
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

// Sends a plain notification with no buttons — used for the auto-send path,
// as an FYI rather than something requiring your input.
export async function sendNotification(text) {
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
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
