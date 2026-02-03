// lib/clickhouse/runMockClickhouseTriage.ts
// Public-safe mock ClickHouse runner.
// Generates metricsJson in the same shape as CSV output.
// If debug=true, includes _debug.sql with the real SQL strings from buildEdgePack().

import { buildEdgePack } from "./packs/edge";

type Inputs = {
  partner: string; // public-safe partner name from UI (e.g., "acme_media")
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;
};

// small deterministic hash so different partners/services give stable-ish numbers
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function round(n: number) {
  return Math.round(n);
}

export async function runMockClickhouseTriage(inputs: Inputs) {
  const { partner, service, region, pop, windowMinutes, debug } = inputs;

  // In real mode, "db" will come from partnerRouting (Option B).
  // For public repo, keep db generic and non-identifying.
  const db = "acme_media_db";

  // Build the real SQL strings (we won't execute them yet).
  const pack = buildEdgePack({
    db,
    service,
    region,
    pop,
    windowMinutes,
  });

  // ----------------------------
  // Fake-but-realistic metrics
  // ----------------------------
  const seed = hashToInt([partner, service, region, pop, String(windowMinutes)].join("|"));

  const baseReq = 120_000 + (seed % 80_000); // 120k–200k
  const errorRate = clamp(((seed % 700) / 10000) + 0.0025, 0.002, 0.02); // ~0.2%–2%
  const error5xxCount = round(baseReq * errorRate);

  const p95 = clamp(420 + (seed % 900), 250, 1800); // ms
  const p99 = clamp(p95 + 250 + (seed % 700), 600, 4000);

  // timeseries (15m buckets to match atsec_15m)
  const bucketSeconds = 15 * 60;
  const now = Date.now();
  const buckets = clamp(Math.floor(windowMinutes / 15), 4, 48); // 1h–12h-ish

  const points = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const ts = new Date(now - i * bucketSeconds * 1000).toISOString();

    // small wave variation
    const wave = Math.sin((seed % 1000) + i / 2) * 0.08;
    const req = round(baseReq / buckets * (1 + wave));
    const e5 = round(req * clamp(errorRate * (1 + wave), 0.0005, 0.05));

    const p95i = clamp(p95 * (1 + wave / 2), 120, 5000);
    const p99i = clamp(p99 * (1 + wave / 2), 200, 8000);

    points.push({
      ts,
      totalRequests: req,
      error5xxCount: e5,
      errorRatePct: req > 0 ? (e5 / req) * 100 : 0,
      p95TtmsMs: round(p95i),
      p99TtmsMs: round(p99i),
      // optional maps (keep small)
      statusCounts: {
        "200": round(req * 0.93),
        "206": round(req * 0.04),
        "500": round(e5 * 0.55),
        "502": round(e5 * 0.25),
        "504": round(e5 * 0.2),
      },
    });
  }

  const hosts = [
    `edge-a.${partner}.example`,
    `edge-b.${partner}.example`,
    `edge-c.${partner}.example`,
    `edge-d.${partner}.example`,
    `edge-e.${partner}.example`,
  ];

  const hostBreakdown = hosts.map((h, idx) => {
    const r = round((baseReq * (0.22 - idx * 0.03)) + (seed % 5000));
    const hp95 = clamp(p95 + idx * 40, 100, 5000);
    const hp99 = clamp(p99 + idx * 70, 200, 8000);

    return {
      host: h,
      totalRequests: clamp(r, 1000, baseReq),
      p95TtmsMs: round(hp95),
      p99TtmsMs: round(hp99),
      crcCounts: {
        TCP_MISS: round(r * 0.35),
        TCP_HIT: round(r * 0.5),
        ERR_READ_TIMEOUT: round(r * 0.01),
        ERR_CONNECT_FAIL: round(r * 0.005),
      },
    };
  });

  const crcByHost = [
    { host: hosts[0], crc: "TCP_MISS", count: round(baseReq * 0.18) },
    { host: hosts[1], crc: "TCP_HIT", count: round(baseReq * 0.16) },
    { host: hosts[2], crc: "ERR_READ_TIMEOUT", count: round(baseReq * 0.006) },
    { host: hosts[3], crc: "ERR_CONNECT_FAIL", count: round(baseReq * 0.004) },
  ].sort((a, b) => b.count - a.count);

  const metricsJson: any = {
    totalRequests: baseReq,
    error5xxCount,
    errorRatePct: baseReq > 0 ? (error5xxCount / baseReq) * 100 : 0,
    p95TtmsMs: p95,
    p99TtmsMs: p99,

    timeseries: {
      bucketSeconds,
      startTs: points[0]?.ts ?? null,
      endTs: points[points.length - 1]?.ts ?? null,
      points,
    },

    hostBreakdown,
    crcByHost,
    _mock: { enabled: true, partner, db, service, region, pop, windowMinutes },
  };

  if (debug) {
    metricsJson._debug = {
      sql: {
        summarySql: pack.summarySql.trim(),
        timeseriesSql: pack.timeseriesSql.trim(),
        hostBreakdownSql: pack.hostBreakdownSql.trim(),
        crcByHostSql: pack.crcByHostSql.trim(),
      },
      note: "Mock mode: SQL is generated but not executed (no ClickHouse credentials).",
    };
  }

  const summaryText =
    `ClickHouse (mock): requests=${baseReq.toLocaleString()}, 5xx=${metricsJson.errorRatePct.toFixed(2)}%, ` +
    `p95=${p95}ms, p99=${p99}ms. Partner=${partner}, svc=${service}.`;

  return { summaryText, metricsJson };
}
