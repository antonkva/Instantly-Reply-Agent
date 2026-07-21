# Reply agent — step 1: webhook receiver

This is the first piece of the pipeline: a server that receives Instantly's
`reply_received` webhook, verifies it, responds instantly (Instantly retries
3x within 30s if you're slow), and logs the payload so you can see its real
shape before building the Claude classification step on top of it.

## 1. Run it locally (optional, just to see it work)

```bash
npm install
cp .env.example .env
# edit .env, set INSTANTLY_WEBHOOK_SECRET to any long random string
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
5. Under **Environment**, add an environment variable:
   - `INSTANTLY_WEBHOOK_SECRET` = a long random string (generate one with
     `openssl rand -hex 32`)
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
