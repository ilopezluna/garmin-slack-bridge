import { afterEach, describe, expect, it, vi } from "vitest";
import { runOnce } from "../bridge";
import {
  buildSlackMessage,
  emojiFor,
  formatDistance,
  formatDuration,
  formatPace,
  formatSpeed,
} from "../slack";
import { fakeActivity, makeEnv, MemKV } from "./helpers";

const TOKEN_URL =
  "https://garmin.test/personalapitoken-service/personal-api/personal-api-key/token";
const LIST_URL =
  "https://garmin.test/activitylist-service/activities/search/activities";
const FRESH_TOKEN = "fresh.payload.signature";

interface SlackPost {
  channel: string;
  text: unknown;
  blocks: unknown;
}

interface Fixture {
  kv: MemKV;
  slackBodies: SlackPost[];
  stub: typeof fetch;
  env: ReturnType<typeof makeEnv>["env"];
}

/** Global fetch stub: token, Garmin listing/splits and Slack chat.postMessage. */
function stubNetwork(
  kv: MemKV,
  activities: unknown[],
  options: {
    slackStatus?: number;
    slackBody?: unknown;
    detail?: unknown;
    detailStatuses?: number[];
    listStatuses?: number[];
    onListStatus?: (status: number) => Promise<void> | void;
  } = {},
): Fixture {
  const slackBodies: SlackPost[] = [];
  let detailCalls = 0;
  let listCalls = 0;
  const stub = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.startsWith(TOKEN_URL)) {
      return new Response(FRESH_TOKEN, { status: 200 });
    }
    if (url.startsWith(LIST_URL)) {
      const status = options.listStatuses?.[listCalls++] ?? 200;
      await options.onListStatus?.(status);
      return new Response(JSON.stringify(activities), { status });
    }
    if (url.startsWith("https://garmin.test/activity-service/activity/")) {
      const status = options.detailStatuses?.[detailCalls++] ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({}), { status });
      }
      if (options.detail) {
        return new Response(JSON.stringify(options.detail), { status: 200 });
      }
      throw new Error(`unexpected URL in stub: ${url}`);
    }
    if (url.startsWith("https://slack.com/api/chat.postMessage")) {
      slackBodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify(options.slackBody ?? { ok: true }), {
        status: options.slackStatus ?? 200,
      });
    }
    throw new Error(`unexpected URL in stub: ${url}`);
  });
  return {
    kv,
    slackBodies,
    stub: stub as unknown as typeof fetch,
    env: makeEnv(kv).env,
  };
}

describe("runOnce", () => {
  it("bootstrap: the first run only sets the watermark, posts nothing", async () => {
    const fx = stubNetwork(new MemKV(), [fakeActivity()]);
    const result = await runOnce(fx.env, fx.stub);

    expect(result).toEqual({ bootstrap: true, posted: 0 });
    expect(fx.slackBodies).toHaveLength(0);
    expect(await fx.kv.get("garmin:watermark")).toBe(
      String(Date.parse("2026-11-08T09:30:00Z")),
    );
  });

  it("posts only activities newer than the watermark, in chronological order", async () => {
    const kv = new MemKV();
    const older = fakeActivity({
      activityId: 111,
      startTimeGMT: "2026-11-07 08:00:00",
    });
    const newer = fakeActivity({
      activityId: 222,
      startTimeGMT: "2026-11-08 09:30:00",
    });

    const fx = stubNetwork(kv, [older]);
    await runOnce(fx.env, fx.stub); // bootstrap on the old one
    expect(await kv.get("garmin:watermark")).toBe(
      String(Date.parse("2026-11-07T08:00:00Z")),
    );

    const fx2 = stubNetwork(kv, [newer, older]);
    const result = await runOnce(fx2.env, fx2.stub);
    expect(result).toEqual({ bootstrap: false, posted: 1 });
    expect(fx2.slackBodies[0].channel).toBe("CTEST123");
    expect(JSON.stringify(fx2.slackBodies[0].blocks)).toContain("activity/222");
    expect(await kv.get("garmin:watermark")).toBe(
      String(Date.parse("2026-11-08T09:30:00Z")),
    );
  });

  it("does not re-post what was already posted (monotonic watermark)", async () => {
    const kv = new MemKV();
    const same = fakeActivity();

    const fx1 = stubNetwork(kv, [same]);
    await runOnce(fx1.env, fx1.stub);

    const fx2 = stubNetwork(kv, [same]);
    const result = await runOnce(fx2.env, fx2.stub);
    expect(result.posted).toBe(0);
    expect(fx2.slackBodies).toHaveLength(0);
  });

  it("posts the activity with detail (splits and location) when Garmin provides it", async () => {
    const kv = new MemKV();
    const older = fakeActivity({
      activityId: 111,
      startTimeGMT: "2026-11-07 08:00:00",
    });
    const fx1 = stubNetwork(kv, [older]);
    await runOnce(fx1.env, fx1.stub); // bootstrap on the old one

    const fx2 = stubNetwork(kv, [fakeActivity({ activityId: 222 })], {
      detail: {
        activityId: 222,
        activityName: "Midday run",
        activityTypeDTO: { typeKey: "running" },
        locationName: "Premià de Mar",
        startTimeGMT: "2026-11-08 09:30:00",
        distance: 10523,
        movingDuration: 3000,
        averageRunCadence: 163.5,
        splitSummaries: [
          {
            splitType: "RWD_RUN",
            distance: 8881.4,
            duration: 3195.9,
            movingDuration: 3120.9,
            averageHR: 134,
          },
          {
            splitType: "RWD_WALK",
            distance: 843.06,
            duration: 682,
            movingDuration: 639,
            averageHR: 138,
          },
        ],
      },
    });
    await runOnce(fx2.env, fx2.stub);
    const blocks = JSON.stringify(fx2.slackBodies[0].blocks);
    expect(blocks).toContain("*Splits*");
    expect(blocks).toContain("*run* 8.88 km · 5:51/km · 134 bpm"); // 3120.9 s / 8.8814 km
    expect(blocks).toContain("*walk* 0.84 km · 12:38/km · 138 bpm"); // 639 s / 0.843 km
    expect(blocks).toContain("📍 Premià de Mar");
    expect(fx2.slackBodies[0].text).toContain("*Splits*");
  });

  it("falls back to the summary when the detail call fails", async () => {
    const kv = new MemKV();
    const older = fakeActivity({
      activityId: 111,
      startTimeGMT: "2026-11-07 08:00:00",
    });
    const fx1 = stubNetwork(kv, [older]);
    await runOnce(fx1.env, fx1.stub);

    // No `detail` option: the stub throws on the detail URL.
    const fx2 = stubNetwork(kv, [fakeActivity({ activityId: 222 })]);
    await runOnce(fx2.env, fx2.stub);
    expect(fx2.slackBodies).toHaveLength(1);
    expect(JSON.stringify(fx2.slackBodies[0].blocks)).not.toContain("Splits");
  });

  it("refreshes the token once and retries when Garmin rejects it with 401", async () => {
    const kv = new MemKV();
    const older = fakeActivity({
      activityId: 111,
      startTimeGMT: "2026-11-07 08:00:00",
    });
    const fx1 = stubNetwork(kv, [older]);
    await runOnce(fx1.env, fx1.stub); // bootstrap on the old one

    // Simulate a stale cached token: plant a bogus one; the stub rejects the
    // first listing attempt with 401 and succeeds on the retry.
    await kv.put("garmin:access-token", "stale-token");
    const fx2 = stubNetwork(kv, [fakeActivity({ activityId: 222 })], {
      listStatuses: [401, 200],
    });

    const result = await runOnce(fx2.env, fx2.stub);
    expect(result).toEqual({ bootstrap: false, posted: 1 });
    expect(fx2.slackBodies).toHaveLength(1);
    expect(await kv.get("garmin:access-token")).toBe(FRESH_TOKEN);
    const listCalls = vi
      .mocked(fx2.stub)
      .mock.calls.filter(([url]) => String(url).startsWith(LIST_URL));
    expect(
      listCalls.map(([, init]) =>
        new Headers(init?.headers).get("Authorization"),
      ),
    ).toEqual(["Bearer stale-token", `Bearer ${FRESH_TOKEN}`]);
  });

  it("refreshes the token when an activity detail request returns 401", async () => {
    const kv = new MemKV();
    await kv.put(
      "garmin:watermark",
      String(Date.parse("2026-11-07T08:00:00Z")),
    );
    await kv.put("garmin:access-token", "stale-token");
    const fx = stubNetwork(kv, [fakeActivity()], {
      detailStatuses: [401, 200],
      detail: fakeActivity({ locationName: "Premià de Mar" }),
    });

    const result = await runOnce(fx.env, fx.stub);

    expect(result).toEqual({ bootstrap: false, posted: 1 });
    expect(JSON.stringify(fx.slackBodies[0].blocks)).toContain("Premià de Mar");
    expect(await kv.get("garmin:access-token")).toBe(FRESH_TOKEN);
    const detailCalls = vi
      .mocked(fx.stub)
      .mock.calls.filter(([url]) =>
        String(url).startsWith(
          "https://garmin.test/activity-service/activity/",
        ),
      );
    expect(
      detailCalls.map(([, init]) =>
        new Headers(init?.headers).get("Authorization"),
      ),
    ).toEqual(["Bearer stale-token", `Bearer ${FRESH_TOKEN}`]);
  });

  it("does not refresh for a non-authentication Garmin error", async () => {
    const kv = new MemKV();
    await kv.put("garmin:access-token", "cached-token");
    const fx = stubNetwork(kv, [fakeActivity()], { listStatuses: [403] });

    await expect(runOnce(fx.env, fx.stub)).rejects.toThrow("403");

    expect(await kv.get("garmin:access-token")).toBe("cached-token");
    expect(
      vi
        .mocked(fx.stub)
        .mock.calls.some(([url]) => String(url).startsWith(TOKEN_URL)),
    ).toBe(false);
  });

  it("retries an unauthorized Garmin request only once", async () => {
    const kv = new MemKV();
    await kv.put("garmin:access-token", "stale-token");
    const fx = stubNetwork(kv, [fakeActivity()], {
      listStatuses: [401, 401],
    });

    await expect(runOnce(fx.env, fx.stub)).rejects.toThrow("401");

    const listCalls = vi
      .mocked(fx.stub)
      .mock.calls.filter(([url]) => String(url).startsWith(LIST_URL));
    expect(listCalls).toHaveLength(2);
  });

  it("reuses a token refreshed by a concurrent run", async () => {
    const kv = new MemKV();
    await kv.put("garmin:access-token", "stale-token");
    const fx = stubNetwork(kv, [fakeActivity()], {
      listStatuses: [401, 200],
      onListStatus: async (status) => {
        if (status === 401) {
          await kv.put("garmin:access-token", "concurrent-token");
        }
      },
    });

    await runOnce(fx.env, fx.stub);

    const listCalls = vi
      .mocked(fx.stub)
      .mock.calls.filter(([url]) => String(url).startsWith(LIST_URL));
    expect(listCalls[1][1]?.headers).toMatchObject({
      Authorization: "Bearer concurrent-token",
    });
    expect(await kv.get("garmin:access-token")).toBe("concurrent-token");
    expect(
      vi
        .mocked(fx.stub)
        .mock.calls.some(([url]) => String(url).startsWith(TOKEN_URL)),
    ).toBe(false);
  });

  it("if Slack fails, it throws and the watermark does not advance (retry on next cron)", async () => {
    const kv = new MemKV();
    const fx = stubNetwork(kv, [fakeActivity()]);
    await runOnce(fx.env, fx.stub);
    const before = await kv.get("garmin:watermark");

    const newer = fakeActivity({
      activityId: 999,
      startTimeGMT: "2026-11-08 12:00:00",
    });
    const fx2 = stubNetwork(kv, [newer], { slackStatus: 500 });
    await expect(runOnce(fx2.env, fx2.stub)).rejects.toThrow("Slack");
    expect(await kv.get("garmin:watermark")).toBe(before);
  });
});

describe("buildSlackMessage", () => {
  const message = buildSlackMessage(fakeActivity());

  it("links the activity in Garmin Connect", () => {
    const first = JSON.stringify(message.blocks[0]);
    expect(first).toContain(
      "https://connect.garmin.com/modern/activity/123456789",
    );
    expect(first).toContain("Midday run");
  });

  it("includes the key fields", () => {
    const body = JSON.stringify(message.blocks);
    expect(body).toContain("10.52 km");
    expect(body).toContain("+85 m");
    expect(body).toContain("avg HR");
    expect(body).toContain("kcal");
    expect(body).toContain("4:45/km"); // 3000 s movingDuration / 10.523 km
  });

  it("carries the full content in text for text-only consumers", () => {
    expect(message.text).toContain("Midday run");
    expect(message.text).toContain("10.52 km");
    expect(message.text).toContain("4:45/km");
    expect(message.text).toContain("+85 m");
    expect(message.text).toContain("avg HR 152 bpm");
    expect(message.text).toContain("703 kcal");
    expect(message.text).toContain("11/08/2026 10:30:00");
    const lines = message.text.split("\n");
    expect(lines[lines.length - 1]).toBe(
      "https://connect.garmin.com/modern/activity/123456789",
    );
  });

  it("does not leak Slack control syntax from the title", () => {
    const shouty = buildSlackMessage(
      fakeActivity({ activityName: "Ride <!channel> *now*" }),
    );
    expect(shouty.text).not.toContain("<!channel>");
    expect(shouty.text).not.toContain("*now*");
    expect(JSON.stringify(shouty.blocks)).not.toContain("<!channel>");
  });

  it("renders enrichment fields and splits when present", () => {
    expect(message.text).not.toContain("Splits"); // the default fixture has no detail
    const rich = buildSlackMessage(
      fakeActivity({
        maxHR: 178,
        elevationLoss: 40,
        averageRunCadence: 163.5,
        locationName: "Premià de Mar",
        splitSummaries: [
          {
            splitType: "RWD_RUN",
            distance: 8881.4,
            duration: 3195.9,
            movingDuration: 3120.9,
            averageHR: 134,
          },
          { splitType: "RWD_STAND", distance: 19.9, duration: 87 },
        ],
      }),
    );
    const body = JSON.stringify(rich.blocks);
    for (const part of [
      "max HR 178 bpm",
      "−40 m",
      "164 spm", // averageRunCadence 163.5 rounds up
      "*Splits*",
      "*run* 8.88 km · 5:51/km · 134 bpm",
      "*stand* 1:27",
      "📍 Premià de Mar",
    ]) {
      expect(body).toContain(part);
    }
    // text mirrors the blocks for text-only consumers
    expect(rich.text).toContain("*Splits*");
    expect(rich.text).toContain("📍 Premià de Mar");
  });

  it("caps the splits section at 10 phases", () => {
    const many = buildSlackMessage(
      fakeActivity({
        splitSummaries: Array.from({ length: 14 }, (_, i) => ({
          splitType: "RWD_RUN",
          distance: 1000,
          duration: 300,
        })),
      }),
    );
    expect(JSON.stringify(many.blocks)).toContain("4 more");
  });

  it("cycling activity shows speed instead of pace", () => {
    const bike = buildSlackMessage(
      fakeActivity({
        activityType: { typeKey: "cycling" },
        averageSpeed: 7.5,
      }),
    );
    const body = JSON.stringify(bike.blocks);
    expect(body).toContain("km/h");
    expect(body).not.toContain("/km");
  });
});

describe("formatting helpers", () => {
  it("formatDistance", () => {
    expect(formatDistance(10523.4)).toBe("10.52 km");
    expect(formatDistance(undefined)).toBeNull();
    expect(formatDistance(0)).toBeNull();
  });

  it("formatDuration", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(95)).toBe("1:35");
  });

  it("formatPace", () => {
    expect(formatPace(1000, 300)).toBe("5:00/km");
    expect(formatPace(500, 7200)).toBeNull(); // absurd pace
  });

  it("formatSpeed", () => {
    expect(formatSpeed(7.5)).toBe("27.0 km/h");
  });

  it("emojiFor", () => {
    expect(emojiFor("running")).toBe("🏃");
    expect(emojiFor("unknown")).toBe("👟");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
