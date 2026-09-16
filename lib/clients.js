const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CACHE_TTL_MS = 60 * 1000;

const CLIENTS_TABLE = "Clients";
const CAMPAIGNS_TABLE = "Campaigns";

let cache = null;
let cacheExpiresAt = 0;

async function fetchAllRecords(table) {
  const records = [];
  let offset;

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`);
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable fetch failed for ${table}: ${res.status} ${body}`);
    }

    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

async function loadClients() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) {
    return cache;
  }

  const [clientRecords, campaignRecords] = await Promise.all([
    fetchAllRecords(CLIENTS_TABLE),
    fetchAllRecords(CAMPAIGNS_TABLE),
  ]);

  const clientsByRecordId = {};
  for (const record of clientRecords) {
    const f = record.fields;
    clientsByRecordId[record.id] = {
      client_name: f["Client Name"] ?? "",
      offer_summary: f["Offer Summary"] ?? "",
      meeting_link_notes: f["Meeting link?"] ?? "",
      calendar_link: f["Calendar Link"] ?? "",
      leads_table_name: f["Leads Table"] ?? "",
      leads_base_id: f["Leads Base ID"] ?? "",
      client_email: f["Client Email"] ?? "",
    };
  }

  const clientsByCampaignId = {};
  for (const record of campaignRecords) {
    const f = record.fields;
    const campaignId = f["Campaign ID"];
    if (!campaignId) continue;

    const linkedClientIds = f["Client"] ?? [];
    const clientRecordId = linkedClientIds[0];
    const client = clientRecordId ? clientsByRecordId[clientRecordId] : null;

    if (!client) {
      console.warn(`Campaign ${campaignId} has no linked client — skipping`);
      continue;
    }

    clientsByCampaignId[campaignId] = {
      ...client,
      icp: f["ICP"] ?? "",
      campaign_overview: f["Campaign Overview"] ?? "",
      common_responses: f["Common responses and answers"] ?? "",
      notes_for_icp: f["Notes for this ICP"] ?? "",
      auto_send_bookings: !!f["Auto-Send Bookings"],
      forward_interested_leads: !!f["Forward Interested Leads"],
    };
  }

  cache = clientsByCampaignId;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return clientsByCampaignId;
}

export async function getClientByCampaignId(campaignId) {
  const clients = await loadClients();
  const client = clients[campaignId];
  if (!client) {
    console.warn(`No client config found for campaign_id: ${campaignId}`);
    return null;
  }
  return client;
}
