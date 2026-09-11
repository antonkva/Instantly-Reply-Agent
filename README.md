# Reply agent — step 1: webhook receiver

This is the first piece of the pipeline: a server that receives Instantly's
`reply_received` webhook, verifies it, responds instantly (Instantly retries
3x within 30s if you're slow), and logs the payload so you can see its real
shape before building the Claude classification step on top of it.

## 0. Set up Airtable (client configs)

Client configs live in Airtable now, not a local file — this lets you (or
a VA) add and edit clients without touching code. Clients and campaigns
are separate tables so a client with multiple campaigns just gets
multiple rows in `Campaigns`, all pointing at the same client — no need
to duplicate their ICP/tone/etc.

1. Create a new Airtable base with three tables, matching these fields
   exactly (case-sensitive):

   **Clients**: `client_name`, `icp`, `tone_notes`, `offer_summary`,
   `calendar_provider`, `calendar_link`, `escalation_contact`,
   `auto_send_allowed` (checkbox)

   **Campaigns**: `campaign_id`, `campaign_name`, `client` (link to Clients)

   **Objections**: `client` (link to Clients), `pattern`, `guidance`

2. Add one row per client in `Clients` — this is the config that stays
   the same regardless of how many campaigns they're running.
3. Add one row per campaign in `Campaigns`, linking each to the right
   client. The `campaign_id` must exactly match what Instantly sends in
   its webhook payload — check your Render logs from a real reply, or
   Instantly's campaign settings, to get the exact value. If a client
   starts a new campaign later, this is the only table you touch — just
   add a new row.
4. Add a few rows in `Objections` for each client, linking each one back
   to the right client via the `client` link field.
5. Create a Personal Access Token at airtable.com/create/tokens (Airtable
   retired plain API keys in 2024 — PATs are the current method). Give it:
   - Scopes: `data.records:read`
   - Access: the specific base you just created
6. Copy your base ID — it's the part of your base's URL starting with
   `app...` (e.g. `airtable.com/appXXXXXXXXXXXXXX/...`).

## 0.5 Get a Gemini API key (for classification/drafting)

1. Go to aistudio.google.com, sign in, and click **Get API key** → **Create API key**.
2. Copy it — starts with `AIza`.
3. You'll add this as `GEMINI_API_KEY` in Render's environment variables (step below).

Cost note: each reply triggers one Gemini API call. Gemini 3.5 Flash is priced for exactly this kind of high-volume, low-complexity task, so at normal reply volumes for a cold email agency this is a very small ongoing cost — worth checking Google AI Studio's usage page once live, but not something to worry about upfront.

## 0.75 Set up your Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts. It gives you a **bot token** like `123456789:ABCdefGhIJKlmNoPQRstuVwxyz`.
2. Send your new bot any message (e.g. "hi") so it has something to look up.
3. Find your **chat ID** by visiting this URL in a browser (replace with your real token):
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
   Look for `"chat":{"id":123456789,...}` in the response — that number is your chat ID.
4. You'll add both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to Render's environment variables (step below).
5. **After deploying**, register the webhook so Telegram knows where to send button taps:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://YOUR-RENDER-URL.onrender.com/webhooks/telegram"
   ```
   You should get back `{"ok":true,"result":true,...}`.

## 0.85 Get an Instantly API v2 key (for sending approved replies)

1. In Instantly: **Settings → Integrations → API**, generate a v2 key (v1 was deprecated in January 2026 — make sure it's v2).
2. Needs the `emails:create` scope (or `all:create`/`all:all`) to send replies.
3. You'll add this as `INSTANTLY_API_KEY` in Render's environment variables (step below). Note this is a different key from the one used earlier to register the webhook — same account, but worth generating one scoped specifically for this if Instantly's UI allows it.

## 1. Run it locally (optional, just to see it work)

```bash
npm install
cp .env.example .env
# edit .env: set INSTANTLY_WEBHOOK_SECRET, AIRTABLE_TOKEN, AIRTABLE_BASE_ID
npm start
```

Test it:
```bash
curl -X POST http://localhost:3000/webhooks/instantly \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: choose-a-long-random-string-here" \
  -d '{"event_type":"reply_received","reply_text":"lets hop on a call"}'
```
You should get `{"received":true}` and see the payload logged in your terminal.

## 2. Deploy it (Render — free tier)

1. Push this folder to a new GitHub repo (Render deploys from a repo, not
   a local folder — create one at github.com/new, then:
   ```bash
   cd reply-agent
   git init
   git add .
   git commit -m "initial webhook receiver"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/reply-agent.git
   git push -u origin main
   ```
2. Go to render.com → sign up (no credit card needed for the free tier) →
   **New** → **Web Service**.
3. Connect your GitHub account and select the `reply-agent` repo.
4. Render auto-detects it as a Node app. Set:
   - **Name**: `reply-agent` (or anything)
   - **Region**: closest to you
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Under **Environment**, add environment variables:
   - `INSTANTLY_WEBHOOK_SECRET` = a long random string (generate one with
     `openssl rand -hex 32`)
   - `AIRTABLE_TOKEN` = your personal access token (starts with `pat`)
   - `AIRTABLE_BASE_ID` = your base ID (starts with `app`)
   - `GEMINI_API_KEY` = your Gemini API key (starts with `AIza`)
   - `TELEGRAM_BOT_TOKEN` = your bot token from BotFather
   - `TELEGRAM_CHAT_ID` = your chat ID from the getUpdates step
   - `INSTANTLY_API_KEY` = your Instantly v2 API key with send scope
6. Click **Create Web Service**. Render builds and deploys automatically.
   Once live, it gives you a public URL like
   `https://reply-agent.onrender.com`.
7. Confirm it's up: visit that URL in a browser, you should see
   "Reply agent webhook receiver is running."

Note on the free tier: the service spins down after a period of
inactivity and takes a few seconds to wake up on the next request. This is
fine here — Instantly retries a webhook 3 times within 30 seconds if it
doesn't get a fast response, so a cold start should still land inside that
window. Worth watching your Render logs for the first real replies to
confirm none get dropped.

Any time you push a new commit to `main`, Render automatically redeploys —
so once this is set up, future changes (like the Claude API step) just
need a `git push`.

## 3. Register the webhook with Instantly

You need an Instantly API key (Settings → Integrations → API in your
Instantly workspace) and to be on the Hypergrowth plan or above — webhooks
are gated behind that tier.

```bash
curl -i -X POST https://api.instantly.ai/api/v2/webhooks \
  -H "Authorization: Bearer YOUR_INSTANTLY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Reply agent - reply received",
    "target_hook_url": "https://reply-agent.onrender.com/webhooks/instantly",
    "event_type": "reply_received",
    "headers": {
      "X-Webhook-Secret": "the-same-long-random-string-you-set-in-render"
    }
  }'
```

Note: create one webhook per campaign, or check whether your Instantly plan
lets you attach a workspace-wide webhook — worth confirming in your
dashboard, since the API examples are scoped per-campaign.

## 4. Send yourself a real test reply

Reply to one of your own test campaigns (or use a real recent reply) and
watch Render's logs (your service page → **Logs** tab). You should see the
real payload structure logged — this matters because reply_received
payloads can vary slightly, and you'll want the exact field names (reply
body, lead email, campaign id) before wiring up the Claude classification
step next.

## What's NOT built yet (next steps)

- `processReplyEvent()` in index.js is currently an empty placeholder —
  this is where the Claude API call for classification + drafting will go.
- No client config lookup yet.
- No chat platform (Telegram/Slack/WhatsApp) integration yet.
- No Instantly "send reply" call yet.

This file intentionally stops at "receive and log the webhook reliably" —
get this deployed and confirmed working with a real reply before adding
the next layer, so you're debugging one thing at a time.
