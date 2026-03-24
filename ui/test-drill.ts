import { executeDrill } from "@/lib/triage/drillExecutor";

async function run() {
  const res = await executeDrill(
    {
      type: "worst_region",
      scope: {
        partner: "partner_01",
        service: "live",
        region: "all",
        pop: "all",
        uaFamily: "all",
        contentType: "all",
      },
      window: {
        windowMinutes: 120,
        timeMode: "relative",
        startTsUtc: null,
        endTsUtc: null,
      },
      targetDimension: "region",
    },
    {} as any,
    {
      runQuery: async () => [
        {
          dimension: "us-east",
          totalRequests: 120000,
          p95TtmsMs: 1800,
          p99TtmsMs: 2500,
          errorRatePct: 1.2,
          cacheHitRate: 72,
        },
      ],
    }
  );

  console.log(JSON.stringify(res, null, 2));
}

run();