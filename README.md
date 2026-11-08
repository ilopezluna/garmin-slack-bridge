# garmin-slack-bridge

Posts new activities you upload to **Garmin Connect** into a Slack channel, using the
**Garmin Connect Personal API** (official, free, read-only) and a **Cloudflare Worker**
on a cron. No subscriptions, no webhooks to maintain.

```text
Garmin watch ──syncs──▶ Garmin Connect
                             │
                             ▼ (cron every 5 min, pull)
               Cloudflare Worker (TypeScript)
               ├─ Personal API token (cached in KV)
               ├─ GET new activities (watermark in KV)
               └─ POST chat.postMessage ──▶ #strava
```

## Features

- **A single Slack scope** (`chat:write`); the bot posts by channel ID.
- **No browser OAuth**: your Garmin personal API key lives in a Secret.
- **Idempotent**: keeps a "watermark" in KV; only posts what is new, in
  chronological order, and the watermark only advances after a successful post.
- **Quiet first run**: does not post your history, only what's new from the deploy on.
- Zero runtime dependencies (native `fetch`). Tested with Vitest, mocked fetch.

## Setup

### 1. Slack

- Slack app with bot scope **`chat:write`**, installed in your workspace.
- Bot invited to the channel: `/invite @your-app`.
- Token `xoxb-...` and the **channel ID** (`C...`, right-click → View channel details).

### 2. Garmin Connect Personal API

- In Garmin Connect Web: **Settings → Personal API Key → Create Key**
  (shown once; pick the longest expiration period available).
- Store the key in your password manager.

### 3. Deploy to Cloudflare

```sh
npm install

# Create the KV and copy its id into wrangler.jsonc
npx wrangler kv namespace create KV

# Secrets (one prompt each)
npx wrangler secret put GARMIN_API_KEY
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_CHANNEL_ID

npx wrangler deploy
# Verify at https://garmin-slack-bridge.<your-subdomain>.workers.dev → {"status":"ok"}
```

On the first cron run the worker only sets the watermark. From then on, every new
activity that reaches Garmin Connect appears in the channel with a title linking to
the activity, pace/speed, HR, elevation, calories and date.

### 4. Local development

```sh
cp .dev.vars.example .dev.vars   # then fill it in with the same secrets
npm run dev                      # wrangler dev --test-scheduled

# Force one cron run without waiting 5 minutes:
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## Trying the API by hand

```sh
# Exchange the key for a token (valid 24 h; the response is the plain-text JWT)
export GC_TOKEN=$(curl -s -X POST \
  'https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token' \
  -H "Accept: */*" \
  -H "Authorization: ApiKey $GARMIN_API_KEY")

# List your 3 most recent activities
curl -s "https://personal.connectapi.garmin.com/activitylist-service/activities/search/activities?start=0&limit=3" \
  -H "Authorization: Bearer $GC_TOKEN" | python3 -m json.tool
```

## Tests and validation

```sh
npm run validate      # prettier + tsc --noEmit + vitest
```

Covered: token exchange/caching, listing (accepts a flat array or `{activities:[...]}`),
watermark semantics (bootstrap, dedupe, retries when Slack fails), Slack message
formatting, and pace-vs-speed selection by sport.

## Design notes

- The Personal API is **pull-only**: there is no webhook on the free tier, hence the cron.
- Renaming or editing an already-posted activity does not re-post it (we only watch
  _new_ activities); listening for title changes would be a natural improvement.
- Tokens are valid for 24 h; we cache them 18 h in KV for headroom.
- Data: the API key and token belong to the athlete themself; the app shares nothing
  with anyone.
- The message is Block Kit, but the `text` field mirrors its full content (title,
  metrics, date and link), so consumers that only read `text` miss nothing.
