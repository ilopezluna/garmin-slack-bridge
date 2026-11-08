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
  options: { slackStatus?: number; slackBody?: unknown; laps?: unknown[] } = {},
): Fixture {
  const slackBodies: SlackPost[] = [];
  const stub = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.startsWith(TOKEN_URL)) {
      return new Response("tok-test", { status: 200 });
    }
    if (url.startsWith(LIST_URL)) {
      return new Response(JSON.stringify(activities), { status: 200 });
    }
    if (url.startsWith("https://garmin.test/activity-service/activity/")) {
      if (options.laps) {
        return new Response(JSON.stringify({ lapDTOs: options.laps }), {
          status: 200,
        });
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
  return { kv, slackBodies, stub: stub as unknown as typeof fetch, env: makeEnv(kv).env };
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

  it("posts the activity with per-lap splits when Garmin provides them", async () => {
    const kv = new MemKV();
    const older = fakeActivity({
      activityId: 111,
      startTimeGMT: "2026-11-07 08:00:00",
    });
    const fx1 = stubNetwork(kv, [older]);
    await runOnce(fx1.env, fx1.stub); // bootstrap on the old one

    const fx2 = stubNetwork(kv, [fakeActivity({ activityId: 222 })], {
      laps: [
        { lapIndex: 1, distance: 1000, duration: 298, averageHR: 151 },
        { lapIndex: 2, distance: 1000, duration: 305, averageHR: 154 },
      ],
    });
    await runOnce(fx2.env, fx2.stub);
    const blocks = JSON.stringify(fx2.slackBodies[0].blocks);
    expect(blocks).toContain("*Splits*");
    expect(blocks).toContain("4:58/km"); // 298 s / 1 km
    expect(fx2.slackBodies[0].text).toContain("*Splits*");
  });

  it("falls back to the summary when the splits call fails", async () => {
    const kv = new MemKV();
    const older = fakeActivity({
      activityId: 111,
      startTimeGMT: "2026-11-07 08:00:00",
    });
    const fx1 = stubNetwork(kv, [older]);
    await runOnce(fx1.env, fx1.stub);

    // No `laps` option: the stub throws on the splits URL.
    const fx2 = stubNetwork(kv, [fakeActivity({ activityId: 222 })]);
    await runOnce(fx2.env, fx2.stub);
    expect(fx2.slackBodies).toHaveLength(1);
    expect(JSON.stringify(fx2.slackBodies[0].blocks)).not.toContain("Splits");
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
    expect(message.text).not.toContain("Splits"); // the default fixture has no laps
    const rich = buildSlackMessage(
      fakeActivity({
        maxHR: 178,
        elevationLoss: 40,
        averageRunningCadence: 172.4,
        averagePower: 210.4,
        trainingEffect: 3.4,
        anaerobicTrainingEffect: 1.2,
        activityTrainingLoad: 245.6,
        laps: [
          { lapIndex: 1, distance: 1000, duration: 298, averageHR: 151 },
          { lapIndex: 2, distance: 1000, duration: 305, averageHR: 154 },
        ],
      }),
    );
    const body = JSON.stringify(rich.blocks);
    for (const part of [
      "max HR 178 bpm",
      "−40 m",
      "172 spm",
      "210 W",
      "TE 3.4/1.2",
      "load 246",
      "*Splits*",
      "4:58/km",
      "151 bpm",
    ]) {
      expect(body).toContain(part);
    }
    // text mirrors the blocks for text-only consumers
    expect(rich.text).toContain("TE 3.4/1.2");
    expect(rich.text).toContain("*Splits*");
  });

  it("caps the splits section at 20 laps", () => {
    const many = buildSlackMessage(
      fakeActivity({
        laps: Array.from({ length: 25 }, (_, i) => ({
          lapIndex: i + 1,
          distance: 1000,
          duration: 300,
        })),
      }),
    );
    expect(JSON.stringify(many.blocks)).toContain("5 more laps");
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
