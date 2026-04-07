// Gojiberry → HubSpot dedupe → Slack alert
// Runs on a Vercel cron every 15 minutes.
//
// Flow:
//   1. Pull recent contacts from Gojiberry
//   2. For each, search HubSpot by LinkedIn URL (then email as fallback)
//   3. If matched and owned by someone other than YOU → send Slack alert
//   4. Otherwise do nothing (let Gojiberry's outreach proceed)

const GOJIBERRY_API = "https://ext.gojiberry.ai/v1";
const HUBSPOT_API = "https://api.hubapi.com";

// How far back to look on each run. Slightly larger than the cron interval
// so we don't miss anything if a run is briefly delayed.
const LOOKBACK_MINUTES = 20;

export default async function handler(req, res) {
  // Basic protection: Vercel cron sends a secret header we can verify.
  if (
    process.env.CRON_SECRET &&
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const newContacts = await fetchRecentGojiberryContacts();
    console.log(`Found ${newContacts.length} recent Gojiberry contacts`);

    const conflicts = [];
    for (const contact of newContacts) {
      const match = await findInHubSpot(contact);
      if (match && match.ownerId && match.ownerId !== process.env.MY_HUBSPOT_OWNER_ID) {
        conflicts.push({ gojiberry: contact, hubspot: match });
      }
    }

    for (const conflict of conflicts) {
      await sendSlackAlert(conflict);
    }

    return res.status(200).json({
      checked: newContacts.length,
      conflicts: conflicts.length,
    });
  } catch (err) {
    console.error("Sync failed:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ─── Gojiberry ────────────────────────────────────────────────────────────

async function fetchRecentGojiberryContacts() {
  const cutoff = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
  const all = [];
  let page = 1;

  while (true) {
    const url = `${GOJIBERRY_API}/contact?page=${page}&limit=50`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.GOJIBERRY_API_KEY}` },
    });

    if (!res.ok) throw new Error(`Gojiberry ${res.status}: ${await res.text()}`);
    const data = await res.json();

    // Assumption: response is { contacts: [...], total: N } or similar.
    // Adjust based on actual response shape once you see it.
    const contacts = data.contacts || data.data || data;
    if (!contacts.length) break;

    for (const c of contacts) {
      const createdAt = new Date(c.createdAt || c.created_at);
      if (createdAt < cutoff) return all; // older than window → done
      all.push(c);
    }

    if (contacts.length < 50) break;
    page++;
  }

  return all;
}

// ─── HubSpot ──────────────────────────────────────────────────────────────

async function findInHubSpot(contact) {
  // Try LinkedIn URL first (most reliable match), then email.
  if (contact.profileUrl) {
    const match = await searchHubSpot("linkedin_url", contact.profileUrl);
    if (match) return match;
  }
  if (contact.email) {
    const match = await searchHubSpot("email", contact.email);
    if (match) return match;
  }
  return null;
}

async function searchHubSpot(propertyName, value) {
  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName, operator: "EQ", value }],
        },
      ],
      properties: ["email", "firstname", "lastname", "hubspot_owner_id", "notes_last_updated"],
      limit: 1,
    }),
  });

  if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.results?.length) return null;

  const c = data.results[0];
  return {
    id: c.id,
    name: `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
    email: c.properties.email,
    ownerId: c.properties.hubspot_owner_id,
    lastActivity: c.properties.notes_last_updated,
  };
}

// ─── Slack ────────────────────────────────────────────────────────────────

async function sendSlackAlert({ gojiberry, hubspot }) {
  const text = `:warning: *Gojiberry conflict* — this lead already exists in HubSpot under another owner.`;

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Name:*\n${gojiberry.firstName} ${gojiberry.lastName}` },
        { type: "mrkdwn", text: `*Company:*\n${gojiberry.company || "—"}` },
        { type: "mrkdwn", text: `*HubSpot owner ID:*\n${hubspot.ownerId}` },
        { type: "mrkdwn", text: `*Last HS activity:*\n${hubspot.lastActivity || "—"}` },
        { type: "mrkdwn", text: `*LinkedIn:*\n<${gojiberry.profileUrl}|View profile>` },
        { type: "mrkdwn", text: `*Gojiberry ID:*\n${gojiberry.id}` },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Remove from the Gojiberry campaign in the UI if you don't want outreach to continue.",
        },
      ],
    },
  ];

  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks }),
  });

  if (!res.ok) console.error(`Slack ${res.status}: ${await res.text()}`);
}
