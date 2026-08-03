import express from "express";
import { getClientByCampaignId } from "./lib/clients.js";
import { classifyAndDraftReply } from "./lib/gemini.js";
import {
  sendApprovalMessage,
  sendNotification,
  answerCallbackQuery,
  getPendingDraft,
  updatePendingDraft,
  deletePendingDraft,
} from "./lib/telegram.js";

const app = express();

app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const WEBHOOK_SECRET = process.env.INSTANTLY_WEBHOOK_SECRET;

const AUTO_SEND_CONFIDENCE = 0.99;
const AUTO_SEND_INTENTS = ["book_call"];
const SUPPRESS_INTENTS = ["unsubscribe", "auto_reply_or_ooo"];

function verifySecret(req) {
  if (!WEBHOOK_SECRET) return true;
  const incoming = req.get("X-Webhook-Secret");
  return incoming === WEBHOOK_SECRET;
}

app.get("/", (_req, res) => {
  res.send("Reply agent webhook receiver is running.");
});

app.post("/webhooks/instantly", async (req, res) => {
  if (!verifySecret(req)) {
    console.warn("Rejected webhook: bad or missing secret");
    return res.status(401).json({ error: "unauthorized" });
  }

  const event = req.body;
  res.status(200).json({ received: true });

  console.log("Event type:", event.event_type ?? event.eventType ?? "unknown");
  console.log("Payload:", JSON.stringify(event, null, 2));

  processReplyEvent(event).catch((err) =>
    console.error("Error processing reply event:", err)
  );
});

app.post("/webhooks/telegram", async (req, res) => {
  res.status(200).json({ ok: true });

  const callbackQuery = req.body.callback_query;
  if (!callbackQuery) return;

  const [action, id] = callbackQuery.data.split(":");
  const draft = getPendingDraft(id);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "This draft is no longer available.");
    return;
  }

  if (action === "send") {
    updatePendingDraft(id, { status: "approved" });
    console.log(`APPROVED for send — client: ${draft.client.client_name}, lead: ${draft.event.lead_email}`);
    console.log(`Draft text: ${draft.classification.draft_reply}`);
    await answerCallbackQuery(callbackQuery.id, "Marked as approved (Instantly send not yet wired up).");
  } else if (action === "delete") {
    deletePendingDraft(id);
    await answerCallbackQuery(callbackQuery.id, "Deleted — no reply will be sent.");
  } else if (action === "edit") {
    await answerCallbackQuery(callbackQuery.id, "Edit isn't wired up yet — reply here manually for now.");
  }
});

async function processReplyEvent(event) {
  if (event.event_type !== "reply_received") {
    return;
  }

  const client = await getClientByCampaignId(event.campaign_id);
  if (!client) {
    return;
  }

  console.log(`Matched client: ${client.client_name}`);
  console.log(`Reply from ${event.firstName ?? event.lead_email}: "${event.reply_text_snippet}"`);

  let result;
  try {
    result = await classifyAndDraftReply(client, event);
  } catch (err) {
    console.error("Classification failed:", err.message);
    return;
  }

  console.log("Classification result:", JSON.stringify(result, null, 2));

  if (SUPPRESS_INTENTS.includes(result.intent)) {
    console.log(`Suppressing — intent "${result.intent}", no reply, no approval needed.`);
    return;
  }

  const shouldAutoSend =
    AUTO_SEND_INTENTS.includes(result.intent) && result.confidence >= AUTO_SEND_CONFIDENCE;

  if (shouldAutoSend) {
    console.log(`AUTO-SEND — intent "${result.intent}" at ${result.confidence} confidence.`);
    try {
      await sendNotification(
        `*Auto-sent* (${client.client_name})\n${event.firstName ?? event.lead_email}\n\n${result.draft_reply}\n\n_(Instantly send not yet wired up — logged only for now)_`
      );
    } catch (err) {
      console.error("Telegram notification failed:", err.message);
    }
    return;
  }

  if (!result.requires_draft) {
    console.log(`No draft required for intent "${result.intent}" — nothing further to do.`);
    return;
  }

  try {
    await sendApprovalMessage(client, event, result);
  } catch (err) {
    console.error("Failed to send Telegram approval message:", err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook receiver listening on port ${PORT}`);
});
