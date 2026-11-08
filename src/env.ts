/** Secrets and bindings expected by the Worker (set via `wrangler secret put` / `.dev.vars`). */
export interface Env {
  /** Garmin Connect personal API key. */
  GARMIN_API_KEY: string;
  /** Optional; defaults to the international instance of the Personal API. */
  GARMIN_BASE_URL?: string;
  /** Slack bot token (`xoxb-...`) with the `chat:write` scope. */
  SLACK_BOT_TOKEN: string;
  /** ID of the target channel (starts with `C`). */
  SLACK_CHANNEL_ID: string;
  /** KV namespace: token cache and watermark of published activities. */
  KV: KVNamespace;
}
