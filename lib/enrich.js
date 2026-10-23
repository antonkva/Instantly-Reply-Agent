// Enriches a warm lead before it's written to the client's lead tracker:
// first/last name, website, phone, and setter notes (what the lead is
// asking for + a short research brief for whoever calls/closes them).
//
// Every value the model returns is checked against something real before
// it's used — names must appear in the thread or email address, a thread
// phone number must appear in the thread, a searched phone number must
// appear on a page we fetch ourselves, and websites must actually load.
// Anything that can't be verified is left blank rather than guessed.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESEARCH_WORDS = 100;

// Personal/free mailbox providers — an email on one of these tells us
// nothing about the lead's business website.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me",
  "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "comcast.net",
  "att.net", "sbcglobal.net", "verizon.net", "bellsouth.net", "cox.net",
  "charter.net", "earthlink.net", "optonline.net", "btinternet.com",
  "bigpond.com", "shaw.ca", "rogers.com", "sympatico.ca",
]);

// ---------- Gemini ----------

async function callGemini({ system, user, schema, search = false }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  // Google Search grounding and a forced JSON schema don't reliably mix,
  // so grounded calls ask for JSON in the prompt and we parse it ourselves.
  const generationConfig = schema
    ? { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 }
    : { temperature: 0.1 };

  const res = await fetch(`${ENDPOINT}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      ...(search ? { tools: [{ google_search: {} }] } : {}),
      generationConfig,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini enrichment request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text) {
    throw new Error(`Gemini enrichment response contained no text: ${JSON.stringify(data)}`);
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Gemini enrichment response had no JSON object. Raw: ${text}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- helpers ----------

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    const text = res.ok ? await res.text() : "";
    return { status: res.status, ok: res.ok, finalUrl: res.url || url, text };
  } catch {
    return null;
  }
}

function emailDomain(email) {
  return (email || "").split("@")[1]?.trim().toLowerCase() || "";
}

function emailLocalPart(email) {
  return (email || "").split("@")[0]?.toLowerCase() || "";
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

// Compare on the last 10 digits so "+1 (555) 123-4567" matches "555.123.4567".
function phoneKey(value) {
  const digits = digitsOnly(value);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function extractPhoneKeys(text) {
  const keys = new Set();
  const matches = String(text || "").match(/(?:tel:)?\+?\d[\d\s().\-]{5,}\d/g) || [];
  for (const m of matches) {
    const key = phoneKey(m);
    if (key.length >= 7) keys.add(key);
  }
  return keys;
}

function textContainsPhone(text, phone) {
  const key = phoneKey(phone);
  if (key.length < 7) return false;
  return extractPhoneKeys(text).has(key);
}

function cleanName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 30 || !/^[\p{L}][\p{L}'\- ]*$/u.test(name)) return "";
  return name
    .split(/(\s+|-)/)
    .map((part) => (/^[\p{L}]/u.test(part) ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("");
}

// A name is only trusted if it actually appears in the thread (e.g. a
// signature or greeting) or in the email address itself.
function verifiedName(value, thread, email) {
  const name = cleanName(value);
  if (!name) return "";
  const lower = name.toLowerCase();
  const letters = lower.replace(/[^\p{L}]/gu, "");
  if (new RegExp(`(^|[^\\p{L}])${lower}([^\\p{L}]|$)`, "u").test(thread.toLowerCase())) return name;
  if (letters.length >= 2 && emailLocalPart(email).replace(/[^\p{L}]/gu, "").includes(letters)) return name;
  return "";
}

function significantTokens(businessName) {
  const stop = new Set(["the", "and", "inc", "llc", "ltd", "co", "company", "corp", "group", "services", "of"]);
  return String(businessName || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 4 && !stop.has(t));
}

function normaliseUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "";
  }
}

function truncateWords(text, max) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.length > max ? `${words.slice(0, max).join(" ")}…` : words.join(" ");
}

// ---------- website ----------

// The lead's own email domain is the most reliable source for their
// website, as long as it isn't a free mailbox provider and it resolves.
async function websiteFromEmail(email) {
  const domain = emailDomain(email);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;

  for (const candidate of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    const page = await fetchPage(candidate);
    // Any HTTP response (even a bot-blocking 403) proves the site exists.
    if (page && page.status < 500) {
      return { url: normaliseUrl(page.finalUrl) || normaliseUrl(candidate), page };
    }
  }
  return null;
}

// A searched website is only accepted if it loads and either its domain
// or its page content mentions the business name.
async function verifySearchedWebsite(url, businessName) {
  const normalised = normaliseUrl(url);
  if (!normalised) return null;
  const page = await fetchPage(normalised);
  if (!page || page.status >= 500) return null;

  const tokens = significantTokens(businessName);
  if (tokens.length === 0) return null;
  const host = new URL(normaliseUrl(page.finalUrl) || normalised).hostname.toLowerCase();
  const body = page.text.toLowerCase();
  const matches = tokens.some((t) => host.includes(t) || body.includes(t));
  return matches ? { url: normaliseUrl(page.finalUrl) || normalised, page } : null;
}

// ---------- step 1: read the thread ----------

const THREAD_SCHEMA = {
  type: "object",
  properties: {
    first_name: { type: "string" },
    last_name: { type: "string" },
    phone: { type: "string" },
    phone_type: { type: "string", enum: ["mobile", "direct", "office", "none"] },
    lead_request: { type: "string" },
  },
  required: ["first_name", "last_name", "phone", "phone_type", "lead_request"],
};

async function readThread(event, thread, classification) {
  const system = `You extract facts about a cold-email LEAD from an email thread. The lead's newest reply is at the top; the quoted message below it was written by the SENDER (our side, ${event.email_account || "the outbound mailbox"}) — never take a name or phone number from the sender's signature.

Return:
- first_name / last_name: the lead's own name. Look first at the lead's signature or sign-off, then the greeting the sender used ("Hi John,"), then the lead's email address prefix (e.g. "john.smith@" → John, Smith; "jsmith@" → last name Smith only if obvious). Generic prefixes like info, hello, contact, office, admin, sales, team, support are NOT names. Use "" for anything you're not sure of. Never guess.
- phone: a phone number the LEAD wrote in their reply or signature, copied exactly as written. Prefer a mobile/cell number if several are given. "" if none.
- phone_type: "mobile" if labelled mobile/cell/m: or clearly a mobile, "direct" or "office" otherwise, "none" if no phone.
- lead_request: 2-6 words naming what the lead is asking for or agreeing to next, e.g. "Website mockup", "Free SEO audit", "Phone call", "Zoom meeting", "Pricing info", "More information", "Loom video". Base it on what they actually agreed to in context of the sender's offer.`;

  const user = `Lead email: ${event.lead_email ?? "unknown"}
Business name: ${event["Business Name"] ?? event.companyName ?? "unknown"}
Classified intent: ${classification?.intent ?? "unknown"}

Thread:
"""
${thread}
"""`;

  return callGemini({ system, user, schema: THREAD_SCHEMA });
}

// ---------- step 2: search the web ----------

async function researchLead({ client, event, thread, businessName, website, firstName, lastName, needWebsite, needPhone, leadRequest }) {
  const asks = [];
  if (needWebsite) {
    asks.push(`- "website": the official website of this exact business (homepage URL). Only return it if you found it in search results and are confident it is this business (matching name, niche and location). Never return directory/social sites (Yelp, Facebook, Yellow Pages, LinkedIn, etc.). "" if not found.`);
  }
  if (needPhone) {
    asks.push(`- "phone": a phone number for this business or this person, preferring the owner's mobile if it is publicly published by the business. Only return a number you saw written on a specific web page about THIS exact business (its own site, Google Business Profile, or an official listing) — accuracy is critical, so return "" rather than anything uncertain. Copy it exactly as written.
- "phone_source_url": the full URL of the page where that phone number appears. "" if no phone.`);
  }
  asks.push(`- "research_notes": max ${MAX_RESEARCH_WORDS - 10} words of factual, verified info to help our client sell to this prospect on a call: what the business does, location, size/years operating, reviews/ratings, the state of their website or marketing, and 1-2 concrete angles tying their situation to our client's offer. Plain sentences, no headings, no fluff. Never invent facts — if little is found, say so briefly.`);

  const system = `You research a sales prospect with Google Search and return ONLY a JSON object (no markdown, no commentary) with these keys:
${asks.join("\n")}`;

  const user = `Our client's offer: ${client.offer_summary || "(not provided)"}
Our client's ICP: ${client.icp || "(not provided)"}

Prospect business: ${businessName || "unknown"}
Niche: ${event.Niche ?? event.niche ?? "unknown"}
Contact: ${[firstName, lastName].filter(Boolean).join(" ") || "unknown"} (${event.lead_email ?? "unknown email"})
Known website: ${website || "unknown"}
Location hints: ${[event.city, event.state, event.location, event.country].filter(Boolean).join(", ") || "none"}
What they're asking for: ${leadRequest || "unknown"}

Their latest reply (for context):
"""
${thread.slice(0, 1500)}
"""`;

  return callGemini({ system, user, search: true });
}

// ---------- main entry point ----------

export async function enrichLead(client, event, classification) {
  const email = event.lead_email || "";
  const thread = event.reply_text || event.reply_text_snippet || "";
  const businessName = event["Business Name"] ?? event.companyName ?? "";

  const out = {
    firstName: cleanName(event.firstName),
    lastName: cleanName(event.lastName),
    website: normaliseUrl(event.website),
    phone: "",
    setterNotes: "",
  };

  // 1. Names, thread phone and the lead's request — straight from the thread.
  let threadInfo = {};
  try {
    threadInfo = await readThread(event, thread, classification);
  } catch (err) {
    console.error("Enrichment: thread extraction failed:", err.message);
  }

  if (!out.firstName) out.firstName = verifiedName(threadInfo.first_name, thread, email);
  if (!out.lastName) out.lastName = verifiedName(threadInfo.last_name, thread, email);

  if (threadInfo.phone && textContainsPhone(thread, threadInfo.phone)) {
    out.phone = threadInfo.phone.trim();
    console.log(`Enrichment: phone (${threadInfo.phone_type}) taken from thread.`);
  }

  // 2. Website from the email domain, if it's a business domain that resolves.
  let websitePage = null;
  if (!out.website) {
    const fromEmail = await websiteFromEmail(email);
    if (fromEmail) {
      out.website = fromEmail.url;
      websitePage = fromEmail.page;
      console.log(`Enrichment: website ${out.website} taken from email domain.`);
    }
  }

  // 3. Google search for anything still missing, plus the research brief.
  let research = {};
  try {
    research = await researchLead({
      client,
      event,
      thread,
      businessName,
      website: out.website,
      firstName: out.firstName,
      lastName: out.lastName,
      needWebsite: !out.website && !!businessName,
      needPhone: !out.phone,
      leadRequest: threadInfo.lead_request,
    });
  } catch (err) {
    console.error("Enrichment: research step failed:", err.message);
  }

  if (!out.website && research.website) {
    const verified = await verifySearchedWebsite(research.website, businessName);
    if (verified) {
      out.website = verified.url;
      websitePage = verified.page;
      console.log(`Enrichment: website ${out.website} found via search and verified.`);
    } else {
      console.log(`Enrichment: searched website "${research.website}" could not be verified — left blank.`);
    }
  }

  // A searched phone number is only used if we can see it ourselves on the
  // cited source page or on the lead's own website.
  if (!out.phone && research.phone) {
    let confirmed = false;
    if (research.phone_source_url) {
      const source = await fetchPage(research.phone_source_url);
      confirmed = !!source && textContainsPhone(source.text, research.phone);
    }
    if (!confirmed && out.website) {
      websitePage = websitePage?.text ? websitePage : await fetchPage(out.website);
      confirmed = !!websitePage && textContainsPhone(websitePage.text, research.phone);
    }
    if (confirmed) {
      out.phone = research.phone.trim();
      console.log("Enrichment: phone found via search and verified on source page.");
    } else {
      console.log(`Enrichment: searched phone "${research.phone}" could not be verified — left blank.`);
    }
  }

  // 4. Setter notes: what they want, a divider, then the research brief.
  const request = (threadInfo.lead_request || "").trim() || "Unclear — check thread";
  const notes = truncateWords(research.research_notes, MAX_RESEARCH_WORDS);
  out.setterNotes = notes
    ? `Looking for: ${request}\n────────────\n${notes}`
    : `Looking for: ${request}`;

  return out;
}
