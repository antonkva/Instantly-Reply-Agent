const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

// Replies at this intent level count as a real, warm engagement worth
// tracking as a lead. Anything else (not_interested, unsubscribe,
// wrong_contact, auto_reply_or_ooo, unclear) never creates/updates a row.
export const WARM_INTENTS = ["book_call", "interested", "objection"];

// Each client's Leads table lives in its own separate Airtable base (app)
// so it can be shared with that client without exposing anyone else's
// data — different from the shared Clients/Campaigns base.
function airtableUrl(baseId, tableName, path = "") {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${path}`;
}

async function findExistingLead(baseId, tableName, email) {
  if (!email) return null;
  const formula = encodeURIComponent(`{Email} = "${email}"`);
  const res = await fetch(airtableUrl(baseId, tableName) + `?filterByFormula=${formula}&maxRecords=1`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable lookup failed for base ${baseId}, table ${tableName}: ${res.status} ${body}`);
  }

  const data = await res.json();
  return data.records[0] ?? null;
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

// Creates a new lead row, or updates the Thread column if this lead
// already exists in the client's table. Never duplicates a lead.
export async function upsertLead(client, event) {
  const tableName = client.leads_table_name;
  const baseId = client.leads_base_id;

  if (!tableName || !baseId) {
    console.warn(
      `Missing "Leads Table" or "Leads Base ID" for client "${client.client_name}" — skipping lead capture.`
    );
    return;
  }
  if (!AIRTABLE_TOKEN) {
    throw new Error("AIRTABLE_TOKEN is not set");
  }

  const email = event.lead_email;
  const thread = event.reply_text || event.reply_text_snippet || "";

  const existing = await findExistingLead(baseId, tableName, email);

  if (existing) {
    const res = await fetch(airtableUrl(baseId, tableName, `/${existing.id}`), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: { Thread: thread } }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable update failed for base ${baseId}, table ${tableName}: ${res.status} ${body}`);
    }

    console.log(`Lead ${email} already existed in "${tableName}" (base ${baseId}) — thread updated.`);
    return "updated";
  }

  const fields = {
    "First Name": event.firstName ?? "",
    "Last Name": event.lastName ?? "",
    "Date": todayISO(),
    "Company": event["Business Name"] ?? event.companyName ?? "",
    "Website": event.website ?? "",
    "Niche": event.Niche ?? event["Niche"] ?? "",
    "Email": email ?? "",
    "Thread": thread,
  };

  const res = await fetch(airtableUrl(baseId, tableName), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable create failed for base ${baseId}, table ${tableName}: ${res.status} ${body}`);
  }

  console.log(`New lead ${email} added to "${tableName}" (base ${baseId}).`);
  return "created";
}
