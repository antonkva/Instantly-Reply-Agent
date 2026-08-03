const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

function buildSystemInstruction(client) {
  return `You are drafting cold-email reply triage for a marketing agency. You are given one client's context and one inbound reply from a lead. Your job is to classify the reply's intent and, if a reply is warranted, draft one.

CLIENT CONTEXT:
Offer summary: ${client.offer_summary || "(not provided)"}
ICP for this campaign: ${client.icp || "(not provided)"}
Campaign overview: ${client.campaign_overview || "(not provided)"}
Common responses and answers this client has given before: ${client.common_responses || "(none provided)"}
Notes specific to this ICP: ${client.notes_for_icp || "(none provided)"}
Meeting/booking approach: ${client.meeting_link_notes || "(not provided)"}

CLASSIFICATION CATEGORIES (pick exactly one):
- "book_call": lead is explicitly asking to talk, call, meet, or asking for availability/times — NOT simply agreeing to receive something (like a mockup, audit, or video) that was already offered
- "interested": lead shows genuine interest, or agrees to the next step already proposed (e.g. "please proceed", "sounds good", "go ahead") — including agreeing to receive content — but hasn't themselves asked to book a call
- "objection": lead raises a specific objection or question that has a reasonable response
- "not_interested": a polite decline, with no further action needed beyond acknowledgement
- "unsubscribe": lead explicitly asks to stop being contacted (e.g. "stop emailing me", "opt me out", "remove me")
- "wrong_contact": lead indicates they are not the right person, or forwards to someone else
- "auto_reply_or_ooo": an automatic out-of-office or vacation reply, not a real response from the person
- "unclear": genuinely ambiguous, cannot classify confidently

CRITICAL CONTEXT RULE: You are given the most recent outbound message the lead is replying to, below. Read it carefully before classifying — short replies like "please proceed", "sounds good", or "yes" only mean "book_call" if the outbound message itself asked to schedule a call or offered specific times. If the outbound message asked something else (e.g. "mind if I send over X?", "worth a look?"), a short affirmative reply means the lead is agreeing to THAT thing, not asking to book a call. Classify based on what was actually being agreed to, not just the surface tone of the reply.

RULES:
- If intent is "unsubscribe" or "auto_reply_or_ooo", set requires_draft to false. These should never receive a drafted reply, only internal handling (suppression).
- If intent is "not_interested" or "wrong_contact", a short, polite, low-effort acknowledgement is appropriate. No re-pitching, no follow-up questions.
- If intent is "book_call", draft a reply and set requires_scheduling to true. Do NOT invent specific times or dates — leave a placeholder like "{{AVAILABLE_SLOTS}}" in the draft where times should go; a separate step will fill in real availability.
- Match the tone that's implied by the client's own past replies and notes above. Keep drafts short — cold email reply tone, not formal business letter tone.
- confidence should reflect how certain you are of the intent classification specifically, from 0 to 1.`;
}

function buildUserMessage(event) {
  const leadName = event.firstName || event.lead_email || "the lead";
  // reply_text includes the lead's new reply AND the quoted prior outbound
  // message(s) beneath it (standard email client quoting). This context is
  // essential — see CRITICAL CONTEXT RULE in the system prompt above.
  const fullThread = event.reply_text || event.reply_text_snippet || "";
  return `Business name: ${event["Business Name"] ?? event.companyName ?? "unknown"}
Lead name: ${leadName}
Lead email: ${event.lead_email ?? "unknown"}

Full email thread (lead's new reply is at the top, the outbound message it's replying to is quoted below it):
"""
${fullThread}
"""`;
}

// Gemini's JSON mode enforces this shape directly, rather than relying on
// prompt instructions alone the way the Claude version did.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "book_call",
        "interested",
        "objection",
        "not_interested",
        "unsubscribe",
        "wrong_contact",
        "auto_reply_or_ooo",
        "unclear",
      ],
    },
    confidence: { type: "number" },
    requires_draft: { type: "boolean" },
    requires_scheduling: { type: "boolean" },
    draft_reply: { type: "string" },
    reasoning: { type: "string" },
  },
  required: [
    "intent",
    "confidence",
    "requires_draft",
    "requires_scheduling",
    "draft_reply",
    "reasoning",
  ],
};

export async function classifyAndDraftReply(client, event) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const res = await fetch(`${ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildSystemInstruction(client) }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: buildUserMessage(event) }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2, // lower temperature for more consistent structured output
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini API response contained no text: ${JSON.stringify(data)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse Gemini's JSON response: ${err.message}. Raw: ${text}`);
  }

  return parsed;
}
