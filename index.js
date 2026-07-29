import express from "express";
import crypto from "crypto";
import { getClientByCampaignId } from "./lib/clients.js";
import { classifyAndDraftReply } from "./lib/gemini.js";

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

// Simple shared-secret check. When you create the webhook in Instantly,
// you set a custom header (see README) — this checks it matches.
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

  // Respond immediately — Instantly retries 3x within 30s if you're slow
  // or don't return a 2xx. Don't do the Claude API call before responding.
  res.status(200).json({ received: true });

  // Log what actually comes through so you can see the real payload shape
  // for reply_received events (field names can vary slightly by event type).
  console.log("Event type:", event.event_type ?? event.eventType ?? "unknown");
  console.log("Payload:", JSON.stringify(event, null, 2));

  // --- Next steps (not yet implemented here) ---
  // 1. Check event.event_type === "reply_received"
  // 2. Look up the client config for event.campaign / event.organization
  // 3. Call the Claude API with the reply text + client config
  // 4. Route to auto-send or chat approval based on confidence
  processReplyEvent(event).catch((err) =>
    console.error("Error processing reply event:", err)
  );
});

async function processReplyEvent(event) {
  if (event.event_type !== "reply_received") {
    return; // only act on actual replies for now
  }

  const client = await getClientByCampaignId(event.campaign_id);
  if (!client) {
    // No config yet for this campaign — add a row to Airtable's Campaigns
    // table with this exact campaign_id, linked to the right client.
    // Logged already inside getClientByCampaignId.
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

  // --- Next step (not yet implemented): ---
  // Route based on result.intent / result.confidence:
  //   - unsubscribe / auto_reply_or_ooo -> suppress, no reply, no human review
  //   - confidence >= 0.99 and intent in allowlist -> auto-send via Instantly
  //   - everything else -> send draft to chat platform for human approval
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook receiver listening on port ${PORT}`);
});
