import {
  activityStartMs,
  getActivityLaps,
  GARMIN_BASE_URL,
  getGarminAccessToken,
  listRecentActivities,
  type FetchFn,
  type GarminActivity,
} from "./garmin";
import type { Env } from "./env";
import {
  buildSlackMessage,
  postSlackMessage,
  type SlackMessage,
} from "./slack";

/** Watermark: last activity start time (UTC ms) successfully posted. */
const WATERMARK_KEY = "garmin:watermark";
const LIST_LIMIT = 50;

export interface RunResult {
  /** true on the very first run (only initializes the watermark, posts nothing). */
  bootstrap: boolean;
  posted: number;
}

function readWatermark(env: Env): Promise<number> {
  return env.KV.get(WATERMARK_KEY).then((v) => Number(v ?? 0));
}

/** Attaches the per-lap splits; if they fail, the summary is posted as-is. */
async function withLaps(
  baseUrl: string,
  token: string,
  activity: GarminActivity,
  fetchFn: FetchFn,
): Promise<GarminActivity> {
  try {
    const laps = await getActivityLaps(
      baseUrl,
      token,
      activity.activityId,
      fetchFn,
    );
    return laps.length > 0 ? { ...activity, laps } : activity;
  } catch (err) {
    console.warn(
      `[garmin-slack-bridge] no splits for ${activity.activityId}: ${err}`,
    );
    return activity;
  }
}

/**
 * One pass of the Garmin → Slack bridge:
 * 1. token (cached in KV),
 * 2. recent activities,
 * 3. posts those newer than the watermark (oldest first),
 *    advancing the watermark only after each successful post.
 *
 * First run: initializes the watermark with the most recent activity without
 * posting anything (the history does not flood the channel).
 */
export async function runOnce(
  env: Env,
  fetchFn: FetchFn = fetch,
): Promise<RunResult> {
  const watermark = await readWatermark(env);
  const token = await getGarminAccessToken(env, fetchFn);
  const baseUrl = env.GARMIN_BASE_URL ?? GARMIN_BASE_URL;
  const activities = await listRecentActivities(
    baseUrl,
    token,
    LIST_LIMIT,
    fetchFn,
  );

  const timed = activities
    .map((activity) => ({ activity, start: activityStartMs(activity) ?? 0 }))
    .filter((x) => x.start > 0);
  const newest = timed.reduce((max, t) => Math.max(max, t.start), 0);

  console.log(
    `[garmin-slack-bridge] token ok; ${activities.length} activities on page; ${timed.length} with a date; watermark=${watermark}; newest=${newest}`,
  );

  if (watermark === 0) {
    if (newest > 0) {
      await env.KV.put(WATERMARK_KEY, String(newest));
    }
    return { bootstrap: true, posted: 0 };
  }

  const toPost = timed
    .filter((t) => t.start > watermark)
    .sort((a, b) => a.start - b.start);
  for (const { activity, start } of toPost) {
    const enriched = await withLaps(baseUrl, token, activity, fetchFn);
    await postSlackMessage(env, buildSlackMessage(enriched), fetchFn);
    // The watermark only advances if the post succeeded: if it fails midway,
    // the next cron retries what is pending without duplicating what was posted.
    await env.KV.put(WATERMARK_KEY, String(start));
  }
  return { bootstrap: false, posted: toPost.length };
}
