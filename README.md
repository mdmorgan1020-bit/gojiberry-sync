# Gojiberry → HubSpot → Slack sync

A tiny Vercel cron job that polls Gojiberry every 15 minutes for new leads,
checks them against HubSpot, and pings Slack if a lead is already owned by
another rep.

## What it does

1. Pulls contacts created in Gojiberry in the last ~20 minutes
2. For each one, searches HubSpot by LinkedIn URL (then email as fallback)
3. If the matched HubSpot contact is owned by someone other than you →
   posts a Slack alert with the lead, current owner, and Gojiberry ID
4. Otherwise does nothing — Gojiberry's outreach proceeds as normal

No database, no state file. The only thing it relies on is the time window.

## Setup (about 20 minutes)

### 1. Get your credentials

- **Gojiberry API key**: From your Gojiberry account settings.
- **HubSpot private app token**: HubSpot → Settings → Integrations → Private
  Apps → Create. Give it `crm.objects.contacts.read` scope. Copy the token.
- **Your HubSpot owner ID**: In HubSpot, go to Settings → Users & Teams,
  click your name, and grab the ID from the URL (it's a number).
- **Slack webhook URL**: api.slack.com → Your Apps → Incoming Webhooks → add
  to your channel. Copy the webhook URL.
- **Cron secret**: Make up any random string. This prevents random people on
  the internet from triggering your endpoint.

### 2. Deploy to Vercel

```bash
npm install -g vercel
cd gojiberry-hubspot-sync
vercel
```

Follow the prompts. Then add the env vars:

```bash
vercel env add GOJIBERRY_API_KEY
vercel env add HUBSPOT_API_KEY
vercel env add MY_HUBSPOT_OWNER_ID
vercel env add SLACK_WEBHOOK_URL
vercel env add CRON_SECRET
```

Then redeploy so the env vars take effect:

```bash
vercel --prod
```

That's it. Vercel will start running `/api/sync` every 15 minutes
automatically based on the schedule in `vercel.json`.

## Testing it manually

You can hit the endpoint yourself to confirm it works:

```bash
curl https://your-project.vercel.app/api/sync \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

You should get back something like `{"checked": 3, "conflicts": 0}`.

## Things to verify before trusting it

The Gojiberry response shape is assumed in `fetchRecentGojiberryContacts`.
The first time you run this, check the Vercel logs and confirm:

- Contacts come back under `data.contacts` or `data.data` (adjust if not)
- Each contact has a `createdAt` or `created_at` field
- The contact object has `firstName`, `lastName`, `profileUrl`, `email`,
  `company`, `id` (adjust the field names if Gojiberry uses different ones)

Same for HubSpot — make sure your HubSpot instance has the `linkedin_url`
custom property. If you've named it something else (e.g., `linkedin_profile`),
update the property name in `searchHubSpot()`.

## Known limitations

- **No persistent dedupe.** If the cron runs at minute 0 and again at minute
  15, a contact created at minute 14 will be checked twice and could trigger
  two Slack alerts. For low volume this is fine. If it gets noisy, add Vercel
  KV or Upstash Redis to track processed contact IDs.
- **First-touch leakage.** Gojiberry may have already sent a LinkedIn message
  before you see the Slack ping. That's the tradeoff with this approach —
  see the chat history for why we chose it over more complex options.
- **HubSpot search rate limits.** HubSpot allows ~100 search requests per 10
  seconds. If Gojiberry suddenly drops 200+ leads in one window, you might
  hit limits. Add a small delay between searches if that happens.
