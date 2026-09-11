const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const ENDPOINT = "https://api.instantly.ai/api/v2/emails/reply";

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

  const res = await fetch(ENDPOINT, {
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
