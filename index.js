import express from "express";
import crypto from "crypto";
import { getClientByCampaignId } from "./lib/clients.js";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const WEBHOOK_SECRET = process.env.INSTANTLY_WEBHOOK_SECRET;

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
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook receiver listening on port ${PORT}`);
});
