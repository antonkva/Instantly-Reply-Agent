import crypto from "crypto";
import { enrichLead } from "./enrich.js";

const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
// Private keys from a downloaded JSON key contain real newlines; when
// pasted into a single-line env var they get stored as literal "\n"
// characters, so we convert those back before use.
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

// Replies at this intent level count as a real, warm engagement worth
// tracking as a lead. Anything else never creates/updates a row.
export const WARM_INTENTS = ["book_call", "interested", "objection"];

// Column layout, matching the template exactly (A through R):
// First Name, Last Name, Email, Date, Company, Website, Niche, Phone,
// Audit/Lead Magnet Sent?, Thread, Setter Notes, Booked, Showed,
// Good Fit, Proposal, Paid, Closed, Closer Notes
const EMAIL_COLUMN = "C";
const THREAD_COLUMN = "J";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExpiresAt - 60) {
    return cachedToken;
  }

  if (!SERVICE_ACCOUNT_EMAIL || !PRIVATE_KEY) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY is not set");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(PRIVATE_KEY, "base64url");
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + data.expires_in;
  return cachedToken;
}

async function findRowByEmail(sheetId, tabName, email) {
  if (!email) return null;
  const token = await getAccessToken();
  const range = `${encodeURIComponent(tabName)}!${EMAIL_COLUMN}:${EMAIL_COLUMN}`;
  const res = await fetch(`${SHEETS_API}/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets read failed for sheet ${sheetId}, tab ${tabName}: ${res.status} ${body}`);
  }

  const data = await res.json();
  const values = data.values || [];
  // Row 1 is the header, so data starts at array index 1 (sheet row 2).
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === email) {
      return i + 1; // convert 0-indexed array position to 1-indexed sheet row
    }
  }
  return null;
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

// Forces Sheets to store a value as plain text — otherwise a phone number
// like "+1 (555) 123-4567" gets parsed as a formula or number.
function asText(value) {
  return value ? `'${value}` : "";
}

export async function upsertLead(client, event, classification) {
  const sheetId = client.sheet_id;
  const tabName = client.sheet_tab;

  if (!sheetId || !tabName) {
    console.warn(`Missing "Sheet ID" or "Sheet Tab" for client "${client.client_name}" — skipping lead capture.`);
    return;
  }

  const email = event.lead_email;
  const thread = event.reply_text || event.reply_text_snippet || "";
  const token = await getAccessToken();

  const existingRow = await findRowByEmail(sheetId, tabName, email);

  if (existingRow) {
    const range = `${encodeURIComponent(tabName)}!${THREAD_COLUMN}${existingRow}`;
    const res = await fetch(`${SHEETS_API}/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: [[thread]] }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sheets update failed for sheet ${sheetId}, tab ${tabName}: ${res.status} ${body}`);
    }

    console.log(`Lead ${email} already existed in "${tabName}" (row ${existingRow}) — thread updated.`);
    return "updated";
  }

  // Names, website, phone and setter notes are enriched from the thread,
  // email domain and a verified Google search. If enrichment fails the
  // row is still written with whatever the webhook gave us.
  let enriched = {};
  try {
    enriched = await enrichLead(client, event, classification);
  } catch (err) {
    console.error(`Lead enrichment failed for ${email} — writing row without it:`, err.message);
  }

  // Everything manual (Booked, Showed, Good Fit, Proposal, Paid, Closed,
  // Closer Notes, Audit/Lead Magnet Sent?) is left blank for the human
  // team to fill in, and is never touched again on later updates.
  const row = [
    enriched.firstName || event.firstName || "", // A: First Name
    enriched.lastName || event.lastName || "",   // B: Last Name
    email ?? "",                 // C: Email
    todayISO(),                  // D: Date
    event["Business Name"] ?? event.companyName ?? "", // E: Company
    enriched.website || event.website || "",     // F: Website
    event.Niche ?? event["Niche"] ?? "", // G: Niche
    asText(enriched.phone),      // H: Phone
    "",                          // I: Audit/Lead Magnet Sent?
    thread,                      // J: Thread
    enriched.setterNotes || "",  // K: Setter Notes
    "", "", "", "", "", "", "",  // L-R: manual fields, left blank
  ];

  const range = `${encodeURIComponent(tabName)}!A:R`;
  const res = await fetch(`${SHEETS_API}/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets append failed for sheet ${sheetId}, tab ${tabName}: ${res.status} ${body}`);
  }

  console.log(`New lead ${email} added to "${tabName}" in sheet ${sheetId}.`);
  return "created";
}
