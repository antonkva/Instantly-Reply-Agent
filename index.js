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

// Instantly sends JSON. Capture the raw body too, in case you later
// want to verify a signature header against it.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const WEBHOOK_SECRET = process.env.INSTANTLY_WEBHOOK_SECRET;

// Auto-send threshold: only intents in this list, at or above this
// confidence, skip human approval entirely.
const AUTO_SEND_CONFIDENCE = 0.99;
const AUTO_SEND_INTENTS = ["book_call"];

// Intents that should never get a drafted reply or approval message —
// only internal suppression (marking the lead as do-not-contact).
const SUPPRESS_INTENTS = ["unsubscribe", "auto_reply_or_ooo"];

function verifySecret(req) {
  if (!WEBHOOK_SECRET) return true; // no secret configured yet, allow through (dev only)
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

// Telegram sends button taps here.
app.post("/webhooks/telegram", async (req, res) => {
  res.status(200).json({ ok: true }); // ack immediately

  const callbackQuery = req.body.callback_query;
  if (!callbackQuery) return; // not a button tap we care about (e.g. a text message)

  const [action, id] = callbackQuery.data.split(":");
  const draft = getPendingDraft(id);

  if (!draft) {
    await answerCallbackQuery(callbackQuery.id, "This draft is no longer available.");
    return;
  }

  if (action === "send") {
    // TODO: actually call Instantly's send-reply API here. For now this
    // just marks it approved and logs — real sending is the next step.
    updatePendingDraft(id, { status: "approved" });
    console.log(`APPROVED for send — client: ${draft.client.client_name}, lead: ${draft.event.lead_email}`);
    console.log(`Draft text: ${draft.classification.draft_reply}`);
    await answerCallbackQuery(callbackQuery.id, "Marked as approved (Instantly send not yet wired up).");
  } else if (action === "delete") {
    deletePendingDraft(id);
    await answerCallbackQuery(callbackQuery.id, "Deleted — no reply will be sent.");
  } else if (action === "edit") {
    // TODO: real editing needs a follow-up text message from you, captured
    // and matched back to this draft. Not yet implemented — flagging it
    // clearly rather than pretending it works.
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
    // TODO: mark lead as do-not-contact in Instantly. For now, just log.
    console.log(`Suppressing — intent "${result.intent}", no reply, no approval needed.`);
    return;
  }

  const shouldAutoSend =
    AUTO_SEND_INTENTS.includes(result.intent) && result.confidence >= AUTO_SEND_CONFIDENCE;

  if (shouldAutoSend) {
    // TODO: actually call Instantly's send-reply API here.
    console.log(`AUTO-SEND — intent "${result.intent}" at ${result.confidence} confidence.`);
    try {
      await sendNotification(
        `Auto-sent (${client.client_name})\n${event.firstName ?? event.lead_email}\n\n${result.draft_reply}\n\n(Instantly send not yet wired up — logged only for now)`
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
