// lib/clickhouse/runMockClickhouseTriage.ts
// Simulated ClickHouse output for public demos (no creds needed).
// Returns the SAME metricsJson shape as the CSV engine.

type Inputs = {
  partner?: string;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// Deterministic pseudo-random (so demos are stable)
function seededRand(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export async function runMockClickhouseTriage(inputs: Inputs) {
  const partner = inputs.partner || "acme_media";
  const service = inputs.service || "all";
  const windowMinutes = clamp(Number(inputs.windowMinutes || 60), 1, 24 * 60);

  const seed = partner.length * 17 + service.length * 31 + windowMinutes;

  const basePerMin = Math.floor(900 + seededRand(seed) * 600); // ~900–1500 req/min
  const totalRequests = basePerMin * windowMinutes;

  const errRate = 0.007 + seededRand(seed + 1) * 0.015; // ~0.7%–2.2%
  const error5xxCount = Math.floor(totalRequests * errRate);

  const p95 = Math.floor(140 + seededRand(seed + 2) * 80); // 140–220ms
  const p99 = p95 + Math.floor(120 + seededRand(seed + 3) * 160); // p95 + 120–280

  const now = Date.now();
  const bucketSeconds = 15 * 60;
  const buckets = clamp(Math.floor(windowMinutes / 15), 4, 48);

  const hosts = [
    `edge-a.${partner}.example`,
    `edge-b.${partner}.example`,
    `edge-c.${partner}.example`,
  ];

  const hostBreakdown = [
    { host: hosts[0], totalRequests: Math.floor(totalRequests * 0.55), p95TtmsMs: p95 - 8, p99TtmsMs: p99 - 20 },
    { host: hosts[1], totalRequests: Math.floor(totalRequests * 0.30), p95TtmsMs: p95 + 6, p99TtmsMs: p99 + 12 },
    { host: hosts[2], totalRequests: Math.floor(totalRequests * 0.15), p95TtmsMs: p95 + 18, p99TtmsMs: p99 + 40 },
  ];

  const crcByHost = [
    { host: hosts[0], crc: "TCP_MISS", count: Math.floor(totalRequests * 0.012) },
    { host: hosts[1], crc: "ERR_CONNECT_FAIL", count: Math.floor(totalRequests * 0.004) },
    { host: hosts[2], crc: "ERR_READ_TIMEOUT", count: Math.floor(totalRequests * 0.002) },
  ];

  const points = Array.from({ length: buckets }).map((_, i) => {
    const ts = new Date(now - (buckets - i) * bucketSeconds * 1000).toISOString();
    const req = Math.floor(totalRequests / buckets + (seededRand(seed + 10 + i) - 0.5) * 200);
    const err = Math.floor(req * errRate);
    return {
      ts,
      totalRequests: Math.max(0, req),
      error5xxCount: Math.max(0, err),
      errorRatePct: req > 0 ? (err * 100) / req : 0,
      p95TtmsMs: p95 + i * 2,
      p99TtmsMs: p99 + i * 3,
    };
  });

  const metricsJson = {
    totalRequests,
    p95TtmsMs: p95,
    p99TtmsMs: p99,
    error5xxCount,
    errorRatePct: totalRequests > 0 ? (error5xxCount * 100) / totalRequests : 0,

    timeseries: {
      bucketSeconds,
      startTs: new Date(now - windowMinutes * 60_000).toISOString(),
      endTs: new Date(now).toISOString(),
      points,
    },

    hostBreakdown,
    crcByHost,

    _mock: {
      enabled: true,
      partner,
      note: "Simulated ClickHouse output (public demo).",
    },
  };

  const summaryText =
    `(${partner}) Simulated ClickHouse triage\n` +
    `Requests: ${totalRequests.toLocaleString()}\n` +
    `5xx: ${((error5xxCount * 100) / Math.max(1, totalRequests)).toFixed(2)}% (${error5xxCount.toLocaleString()})\n` +
    `p95 TTMS: ${p95} ms\n` +
    `p99 TTMS: ${p99} ms\n`;

  return { summaryText, metricsJson };
}
