import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityStartMs,
  extractAccessToken,
  getActivityDetail,
  getGarminAccessToken,
  listRecentActivities,
  obtainGarminToken,
} from "../garmin";
import { fakeActivity, makeEnv } from "./helpers";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("extractAccessToken", () => {
  it("accepts access_token", () => {
    expect(extractAccessToken({ access_token: "abc" })).toBe("abc");
  });
  it("tolerates the token alias", () => {
    expect(extractAccessToken({ token: "abc" })).toBe("abc");
  });
  it("returns null without a usable field", () => {
    expect(extractAccessToken({ other: 1 })).toBeNull();
    expect(extractAccessToken(null)).toBeNull();
  });
});

describe("obtainGarminToken", () => {
  it("uses the ApiKey authorization header and returns the plaintext token", async () => {
    const stub = vi.fn(
      async (_input?: unknown, _init?: any) =>
        new Response(" header.payload.signature ", { status: 200 }),
    );
    const token = await obtainGarminToken(
      "https://garmin.test",
      "key-123",
      stub,
    );
    expect(token).toBe("header.payload.signature");
    const [url, init] = stub.mock.calls[0];
    expect(String(url)).toContain("/personalapitoken-service/");
    expect(init?.headers).toMatchObject({
      Authorization: "ApiKey key-123",
      Accept: "*/*",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("also tolerates a JSON body with access_token", async () => {
    const stub = vi.fn(async () =>
      jsonResponse(200, { access_token: "tok-json" }),
    );
    expect(await obtainGarminToken("https://garmin.test", "key", stub)).toBe(
      "tok-json",
    );
  });

  it("throws when Garmin fails", async () => {
    const stub = vi.fn(async (_input?: unknown, _init?: any) =>
      jsonResponse(500, {}),
    );
    await expect(
      obtainGarminToken("https://garmin.test", "key", stub),
    ).rejects.toThrow("500");
  });

  it("throws on an empty response", async () => {
    const stub = vi.fn(async () => new Response("   "));
    await expect(
      obtainGarminToken("https://garmin.test", "key", stub),
    ).rejects.toThrow("empty");
  });

  it("throws when a JSON response does not contain a token", async () => {
    const stub = vi.fn(async () => jsonResponse(200, { expires_in: 86400 }));
    await expect(
      obtainGarminToken("https://garmin.test", "key", stub),
    ).rejects.toThrow("does not contain an access token");
  });

  it("rejects a non-JSON response that is not a JWT", async () => {
    const stub = vi.fn(async () => new Response("service unavailable"));
    await expect(
      obtainGarminToken("https://garmin.test", "key", stub),
    ).rejects.toThrow("invalid plaintext response");
  });

  it.each([
    ["an array", []],
    ["a string", "serialized-token"],
    ["a number", 123],
  ])("rejects JSON whose top level is %s", async (_name, body) => {
    const stub = vi.fn(async () => jsonResponse(200, body));
    await expect(
      obtainGarminToken("https://garmin.test", "key", stub),
    ).rejects.toThrow("does not contain an access token");
  });
});

describe("getGarminAccessToken", () => {
  it("caches the token in KV and does not re-exchange it", async () => {
    const { env, kv } = makeEnv();
    const stub = vi.fn(async () => new Response("cached.payload.signature"));

    expect(await getGarminAccessToken(env, stub)).toBe(
      "cached.payload.signature",
    );
    expect(await getGarminAccessToken(env, stub)).toBe(
      "cached.payload.signature",
    );
    expect(stub).toHaveBeenCalledTimes(1);
    expect(await kv.get("garmin:access-token")).toBe(
      "cached.payload.signature",
    );
  });
});

describe("listRecentActivities", () => {
  it("returns the array of activities", async () => {
    const a = fakeActivity();
    const stub = vi.fn(async (_input?: unknown, _init?: any) =>
      jsonResponse(200, [a]),
    );
    const list = await listRecentActivities(
      "https://garmin.test",
      "tok",
      50,
      stub,
    );
    expect(list).toEqual([a]);
    expect(String(stub.mock.calls[0][0])).toContain(
      "/activitylist-service/activities/search/activities?start=0&limit=50",
    );
    expect(stub.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer tok");
    expect(stub.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("clamps the requested limit to 100", async () => {
    const stub = vi.fn(async (_input?: unknown, _init?: any) =>
      jsonResponse(200, []),
    );
    await listRecentActivities("https://garmin.test", "tok", 500, stub);
    expect(String(stub.mock.calls[0][0])).toContain("limit=100");
  });

  it("accepts the { activities: [...] } shape", async () => {
    const stub = vi.fn(async (_input?: unknown, _init?: any) =>
      jsonResponse(200, { activities: [fakeActivity()] }),
    );
    expect(
      (await listRecentActivities("https://garmin.test", "tok", 1, stub))
        .length,
    ).toBe(1);
  });
});

describe("getActivityDetail", () => {
  it("flattens summaryDTO and keeps the detail-only fields", async () => {
    const stub = vi.fn(async (_input?: unknown, _init?: any) =>
      jsonResponse(200, {
        activityId: 123,
        activityName: "Run",
        locationName: "Premià de Mar",
        splitSummaries: [{ splitType: "RWD_RUN", distance: 8881 }],
        summaryDTO: { distance: 9740, averageRunCadence: 163.5, maxHR: 147 },
      }),
    );
    const detail = await getActivityDetail(
      "https://garmin.test",
      "tok",
      123,
      stub,
    );
    expect(String(stub.mock.calls[0][0])).toBe(
      "https://garmin.test/activity-service/activity/123",
    );
    expect(stub.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(detail).toEqual({
      activityId: 123,
      activityName: "Run",
      locationName: "Premià de Mar",
      splitSummaries: [{ splitType: "RWD_RUN", distance: 8881 }],
      distance: 9740,
      averageRunCadence: 163.5,
      maxHR: 147,
    });
  });

  it("throws when Garmin fails", async () => {
    const stub = vi.fn(async (_input?: unknown, _init?: any) =>
      jsonResponse(404, {}),
    );
    await expect(
      getActivityDetail("https://garmin.test", "tok", 1, stub),
    ).rejects.toThrow("404");
  });
});

describe("activityStartMs", () => {
  it("parses Garmin's GMT format", () => {
    expect(
      activityStartMs({ activityId: 1, startTimeGMT: "2026-11-08 06:30:00" }),
    ).toBe(Date.parse("2026-11-08T06:30:00Z"));
  });
  it("returns null without a date", () => {
    expect(activityStartMs({ activityId: 1 })).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
