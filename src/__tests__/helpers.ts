import type { Env } from "../env";
import type { GarminActivity } from "../garmin";

/** In-memory KV for tests. */
export class MemKV {
  private store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
  peek(key: string): string | null {
    return this.store.get(key) ?? null;
  }
}

export interface TestEnv {
  env: Env;
  kv: MemKV;
}

/** Test env backed by the in-memory KV. `GARMIN_BASE_URL` points to a mock. */
export function makeEnv(kv = new MemKV()): TestEnv {
  return {
    kv,
    env: {
      GARMIN_API_KEY: "test-api-key",
      GARMIN_BASE_URL: "https://garmin.test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_CHANNEL_ID: "CTEST123",
      KV: kv as unknown as Env["KV"],
    },
  };
}

/** Typical activity; override specific fields as needed. */
export function fakeActivity(
  overrides: Partial<GarminActivity> = {},
): GarminActivity {
  return {
    activityId: 123456789,
    activityName: "Midday run",
    description: "3 x 1 km pops",
    activityType: { typeKey: "running" },
    startTimeGMT: "2026-11-08 09:30:00",
    startTimeLocal: "11/08/2026 10:30:00",
    distance: 10523,
    duration: 3100,
    elapsedDuration: 3200,
    movingDuration: 3000,
    elevationGain: 85,
    averageHR: 152,
    maxHR: 178,
    calories: 703,
    // Overrides go last: they win over the defaults.
    ...overrides,
  };
}
