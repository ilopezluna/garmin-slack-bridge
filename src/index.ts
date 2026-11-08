import { runOnce } from "./bridge";
import type { Env } from "./env";

export default {
  /** Health-check only: handy to verify the deployment. All logic lives in `scheduled`. */
  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  },

  /** Cron Trigger (every 5 min): polls for new Garmin activities and posts them to Slack. */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    await runOnce(env);
  },
} satisfies ExportedHandler<Env>;
