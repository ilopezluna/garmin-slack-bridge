import type { Env } from "./env";
import { activityTypeKey, type GarminActivity } from "./garmin";

export type FetchFn = typeof fetch;

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

export const SLACK_API = "https://slack.com/api/chat.postMessage";

// ---- Formatting ------------------------------------------------------------

export function formatDistance(meters?: number): string | null {
  if (typeof meters !== "number" || meters <= 0) return null;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatDuration(seconds?: number): string | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function formatPace(meters?: number, seconds?: number): string | null {
  if (
    typeof meters !== "number" ||
    typeof seconds !== "number" ||
    meters <= 0 ||
    seconds <= 0
  ) {
    return null;
  }
  const secPerKm = seconds / (meters / 1000);
  const m = Math.floor(secPerKm / 60);
  if (m > 99) return null; // a pace above 99 min/km makes no sense
  const s = Math.round(secPerKm - m * 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

export function formatSpeed(metersPerSecond?: number): string | null {
  if (typeof metersPerSecond !== "number" || metersPerSecond <= 0) return null;
  return `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

const EMOJI: Record<string, string> = {
  running: "🏃",
  treadmill_running: "🏃",
  trail_running: "🥾",
  virtual_run: "🏃",
  walking: "🚶",
  hiking: "🥾",
  cycling: "🚴",
  road_biking: "🚴",
  mountain_biking: "🚵",
  gravel_cycling: "🚴",
  cyclocross: "🚴",
  virtual_ride: "🚴",
  pool_swim: "🏊",
  lap_swimming: "🏊",
  open_water: "🌊",
  rowing: "🚣",
  rowing_indoor: "🚣",
  strength_training: "🏋️",
  yoga: "🧘",
  indoor_cardio: "🤸",
  elliptical: "🏃",
  skiing: "⛷️",
  snowboarding: "🏂",
  golf: "⛳",
  tennis: "🎾",
  soccer: "⚽",
};

export function emojiFor(typeKey: string): string {
  return EMOJI[typeKey.toLowerCase()] ?? "👟";
}

/** Escapes the title for mrkdwn (keeps `<url|text>` and emphasis intact). */
function escapeTitle(title: string): string {
  return title
    .replace(/\\/g, "\\\\")
    .replace(/([*_`])/g, "\\$1")
    .replace(/([<>|])/g, "");
}

function mrkdwn(text: string) {
  return { type: "mrkdwn", text };
}

/** First finite numeric value among Garmin's tolerated field names. */
function firstNumber(
  activity: GarminActivity,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = activity[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Builds the Block Kit message for an activity. */
export function buildSlackMessage(activity: GarminActivity): SlackMessage {
  const key = activityTypeKey(activity);
  const emoji = emojiFor(key);
  const title = activity.activityName || "Activity";
  const link = `https://connect.garmin.com/modern/activity/${activity.activityId}`;

  const fields: string[] = [];
  const distance = formatDistance(activity.distance);
  if (distance) fields.push(distance);
  const duration =
    formatDuration(activity.duration ?? activity.elapsedDuration) ?? null;
  if (duration) fields.push(duration);

  if (key.includes("run") || key.includes("walk") || key.includes("hike")) {
    const pace = formatPace(
      activity.distance,
      activity.movingDuration ?? activity.duration,
    );
    if (pace) fields.push(pace);
  } else if (key.includes("cycl") || key.includes("bik")) {
    const speed = formatSpeed(activity.averageSpeed);
    if (speed) fields.push(speed);
  }

  if (activity.elevationGain && activity.elevationGain > 0) {
    fields.push(`+${Math.round(activity.elevationGain)} m`);
  }
  if (activity.elevationLoss && activity.elevationLoss > 0) {
    fields.push(`−${Math.round(activity.elevationLoss)} m`);
  }
  if (activity.averageHR && activity.averageHR > 0) {
    fields.push(`avg HR ${Math.round(activity.averageHR)} bpm`);
  }
  if (activity.maxHR && activity.maxHR > 0) {
    fields.push(`max HR ${Math.round(activity.maxHR)} bpm`);
  }
  const cadence = firstNumber(
    activity,
    "averageRunCadence",
    "averageRunningCadence",
  );
  if (cadence && cadence > 0) fields.push(`${Math.round(cadence)} spm`);
  if (activity.calories && activity.calories > 0) {
    fields.push(`${Math.round(activity.calories)} kcal`);
  }

  const when = activity.startTimeLocal ?? activity.startTimeGMT;
  const whenLine = when
    ? [
        `🗓️ ${when}`,
        activity.locationName ? `📍 ${activity.locationName}` : null,
        "via Garmin Connect",
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: mrkdwn(`*${emoji} <${link}|${escapeTitle(title)}>*`),
    },
  ];
  if (fields.length > 0) {
    blocks.push({
      type: "section",
      text: mrkdwn(fields.join(" · ")),
    });
  }

  // Run/walk/interval phases from the detail endpoint (Splits section).
  const summaries = activity.splitSummaries ?? [];
  let splits: string | null = null;
  if (summaries.length > 0) {
    const lines = summaries.slice(0, 10).map((s) => {
      const label = (s.splitType ?? "split")
        .replace(/^(RWD|INTERVAL)_/, "")
        .toLowerCase();
      const effort =
        label === "stand"
          ? formatDuration(s.duration)
          : (formatPace(s.distance, s.movingDuration ?? s.duration) ??
            formatDuration(s.duration));
      const hr =
        s.averageHR && s.averageHR > 0
          ? `${Math.round(s.averageHR)} bpm`
          : null;
      return `*${label}* ${[
        ...(label === "stand" ? [] : [formatDistance(s.distance)]),
        effort,
        hr,
      ]
        .filter(Boolean)
        .join(" · ")}`;
    });
    if (summaries.length > 10) lines.push(`…and ${summaries.length - 10} more`);
    splits = ["*Splits*", ...lines].join("\n");
    blocks.push({ type: "section", text: mrkdwn(splits) });
  }

  if (whenLine) {
    blocks.push({
      type: "context",
      elements: [mrkdwn(whenLine)],
    });
  }

  // The `text` field mirrors the blocks so text-only consumers
  // (notifications, workflows) still get the whole content. The title
  // is escaped too: unescaped, a name like "<!channel>" would ping.
  const textLines = [
    `${emoji} ${escapeTitle(title)}${
      fields.length > 0 ? ` — ${fields.join(" · ")}` : ""
    }`,
  ];
  if (whenLine) textLines.push(whenLine);
  if (splits) textLines.push(splits);
  textLines.push(link);
  const text = textLines.join("\n");
  return { text, blocks };
}

// ---- Sending ---------------------------------------------------------------

/** Posts an activity to the configured channel. Throws if Slack returns an error. */
export async function postSlackMessage(
  env: Env,
  message: SlackMessage,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const res = await fetchFn(SLACK_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL_ID,
      text: message.text,
      blocks: message.blocks,
    }),
  });
  if (!res.ok) {
    throw new Error(`Slack returned ${res.status}`);
  }
  const body = (await res.json()) as { ok?: boolean; error?: string };
  if (body.ok !== true) {
    throw new Error(`Slack error: ${body.error ?? "unknown"}`);
  }
}
