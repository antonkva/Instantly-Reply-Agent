const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const REPLY_ENDPOINT = "https://api.instantly.ai/api/v2/emails/reply";
const FORWARD_ENDPOINT = "https://api.instantly.ai/api/v2/emails/forward";

export async function sendReply(event, replyText) {
  if (!INSTANTLY_API_KEY) {
    throw new Error("INSTANTLY_API_KEY is not set");
  }
  if (!event.email_account || !event.email_id) {
    throw new Error(
      `Missing email_account or email_id on event — cannot send. email_account: ${event.email_account}, email_id: ${event.email_id}`
    );
  }

  const subject = event.reply_subject?.startsWith("Re:")
    ? event.reply_subject
    : `Re: ${event.reply_subject ?? ""}`;

  const res = await fetch(REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INSTANTLY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      eaccount: event.email_account,
      reply_to_uuid: event.email_id,
      subject,
      body: {
        text: replyText,
        html: `<p>${replyText.replace(/\n/g, "<br>")}</p>`,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instantly send-reply failed: ${res.status} ${body}`);
  }

  return res.json();
}

// Forwards the actual original email thread to the client's own inbox,
// using Instantly's native forward endpoint — the client sees the real
// email as it looked in the mailbox, not a custom notification.
export async function forwardEmailToClient(event, toEmail) {
  if (!INSTANTLY_API_KEY) {
    throw new Error("INSTANTLY_API_KEY is not set");
  }
  if (!event.email_account || !event.email_id) {
    throw new Error(
      `Missing email_account or email_id on event — cannot forward. email_account: ${event.email_account}, email_id: ${event.email_id}`
    );
  }
  if (!toEmail) {
    throw new Error("No destination email address provided to forward to.");
  }

  const subject = event.reply_subject?.startsWith("Fwd:")
    ? event.reply_subject
    : `Fwd: ${event.reply_subject ?? ""}`;

  const note =
    `A lead just replied and looks interested — forwarding for visibility.\n\n` +
    `Lead: ${event.firstName || event.lead_email}\n` +
    `Email: ${event.lead_email ?? "unknown"}\n\n`;

  const res = await fetch(FORWARD_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INSTANTLY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      eaccount: event.email_account,
      reply_to_uuid: event.email_id,
      to_address_email_list: toEmail,
      subject,
      body: {
        text: note,
        html: `<p>${note.replace(/\n/g, "<br>")}</p>`,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instantly forward failed: ${res.status} ${body}`);
  }

  return res.json();
}
