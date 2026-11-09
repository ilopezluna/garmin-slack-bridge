import type { Env } from "./env";

/** Base URL of Garmin's Personal API (international instance). */
export const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";

export type FetchFn = typeof fetch;

const TOKEN_PATH =
  "/personalapitoken-service/personal-api/personal-api-key/token";
const ACTIVITIES_PATH = "/activitylist-service/activities/search/activities";
const ACTIVITY_PATH = "/activity-service/activity";
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Garmin tokens are valid for 24 h; we cache them a bit less for headroom. */
export const TOKEN_TTL_SECONDS = 60 * 60 * 18;
export const TOKEN_CACHE_KEY = "garmin:access-token";
const GARMIN_REQUEST_TIMEOUT_MS = 15_000;

export class GarminHttpError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`Garmin returned ${status} ${operation}`);
    this.name = "GarminHttpError";
  }
}

function fetchGarmin(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(GARMIN_REQUEST_TIMEOUT_MS),
  });
}

/** Extracts the access token from the token endpoint response, tolerating field naming. */
export function extractAccessToken(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  for (const key of ["access_token", "token", "accessToken"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Exchanges the personal API key for an access token JWT (valid for 24 h).
 * Mirrors Garmin's official client: wildcard Accept header and plaintext response. */
export async function obtainGarminToken(
  baseUrl: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const res = await fetchGarmin(fetchFn, `${baseUrl}${TOKEN_PATH}`, {
    method: "POST",
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: "*/*" },
  });
  if (!res.ok) {
    throw new GarminHttpError(res.status, "when requesting the token");
  }
  const raw = (await res.text()).trim();
  // The token usually comes as plaintext (a JWT); we also tolerate JSON with access_token.
  if (!raw) {
    throw new Error("Garmin token: empty response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    if (["{", "[", '"'].includes(raw[0])) {
      throw new Error("Garmin token: malformed JSON response", { cause: err });
    }
    if (!JWT_PATTERN.test(raw)) {
      throw new Error("Garmin token: invalid plaintext response");
    }
    return raw;
  }

  const token = extractAccessToken(parsed);
  if (!token) {
    throw new Error("Garmin token: response does not contain an access token");
  }
  return token;
}

/** Returns an access token: from KV if cached, otherwise exchanged from the API key. */
export async function getGarminAccessToken(
  env: Env,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const cached = await env.KV.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const token = await obtainGarminToken(
    env.GARMIN_BASE_URL ?? GARMIN_BASE_URL,
    env.GARMIN_API_KEY,
    fetchFn,
  );
  await env.KV.put(TOKEN_CACHE_KEY, token, {
    expirationTtl: TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Reuses a token cached by another run, otherwise replaces the rejected token. */
export async function refreshGarminAccessToken(
  env: Env,
  rejectedToken: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const cached = await env.KV.get(TOKEN_CACHE_KEY);
  if (cached && cached !== rejectedToken) return cached;

  try {
    const token = await obtainGarminToken(
      env.GARMIN_BASE_URL ?? GARMIN_BASE_URL,
      env.GARMIN_API_KEY,
      fetchFn,
    );
    await env.KV.put(TOKEN_CACHE_KEY, token, {
      expirationTtl: TOKEN_TTL_SECONDS,
    });
    return token;
  } catch (err) {
    const concurrent = await env.KV.get(TOKEN_CACHE_KEY);
    if (concurrent && concurrent !== rejectedToken) return concurrent;
    throw err;
  }
}

/** Activity summary as returned by the Personal API listing endpoint. */
export interface GarminActivity {
  activityId: number | string;
  activityName?: string;
  description?: string;
  activityType?: string | { typeKey?: string };
  type?: string | { typeKey?: string };
  activityTypeDTO?: { typeKey?: string };
  startTimeGMT?: string;
  startTimeLocal?: string;
  distance?: number; // meters
  duration?: number; // seconds
  elapsedDuration?: number;
  movingDuration?: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageHR?: number;
  maxHR?: number;
  calories?: number;
  averageSpeed?: number; // m/s
  maxSpeed?: number;
  startLatitude?: number;
  startLongitude?: number;
  splitSummaries?: GarminSplitSummary[];
  locationName?: string;
  [key: string]: unknown;
}

/** One run/walk/interval phase of an activity, from the detail endpoint. */
export interface GarminSplitSummary {
  splitType?: string; // "RWD_RUN", "RWD_WALK", "INTERVAL_ACTIVE"...
  distance?: number; // meters
  duration?: number; // seconds
  movingDuration?: number;
  averageHR?: number;
  [key: string]: unknown;
}

function parseSearchResponse(json: unknown): GarminActivity[] {
  if (Array.isArray(json))
    return json.filter((x): x is GarminActivity => x !== null);
  if (json && typeof json === "object") {
    const list = (json as { activities?: unknown }).activities;
    if (Array.isArray(list))
      return list.filter((x): x is GarminActivity => x !== null);
  }
  console.log(
    `[garmin-slack-bridge] unexpected listing response shape: ${JSON.stringify(json)?.slice(0, 300)}`,
  );
  return [];
}

/** Sport type key ("running", "cycling"...), tolerating string or object. */
export function activityTypeKey(activity: GarminActivity): string {
  const raw =
    activity.activityType ?? activity.type ?? activity.activityTypeDTO;
  if (typeof raw === "string") return raw;
  return raw?.typeKey ?? "";
}

/** Lists the most recent activities (documented max limit: 100). */
export async function listRecentActivities(
  baseUrl: string,
  bearerToken: string,
  limit: number,
  fetchFn: FetchFn = fetch,
): Promise<GarminActivity[]> {
  const url = `${baseUrl}${ACTIVITIES_PATH}?start=0&limit=${Math.min(limit, 100)}`;
  const res = await fetchGarmin(fetchFn, url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new GarminHttpError(res.status, "when listing activities");
  }
  const json = (await res.json()) as unknown;
  return parseSearchResponse(json);
}

/** Fetches the full activity detail and flattens its summaryDTO into the activity.
 * Adds fields the list lacks: cadence, stride, steps, intensity minutes,
 * locationName and splitSummaries (run/walk/interval phases). */
export async function getActivityDetail(
  baseUrl: string,
  bearerToken: string,
  activityId: number | string,
  fetchFn: FetchFn = fetch,
): Promise<GarminActivity> {
  const res = await fetchGarmin(
    fetchFn,
    `${baseUrl}${ACTIVITY_PATH}/${activityId}`,
    {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!res.ok) {
    throw new GarminHttpError(res.status, `for detail of ${activityId}`);
  }
  const detail = (await res.json()) as
    (GarminActivity & { summaryDTO?: GarminActivity }) | null;
  if (!detail) return { activityId };
  const { summaryDTO, ...rest } = detail;
  return { ...rest, ...(summaryDTO ?? {}) };
}

/** Converts `startTimeGMT` ("2026-11-08 06:30:00" or ISO) into UTC milliseconds. */
export function activityStartMs(activity: GarminActivity): number | null {
  const raw = activity.startTimeGMT;
  if (!raw) return null;
  const normalized = raw.endsWith("Z") ? raw : `${raw.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
