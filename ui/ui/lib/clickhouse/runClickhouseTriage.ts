// ui/lib/clickhouse/runMockClickhouseTriage.ts
// Public-safe mock ClickHouse runner.
// IMPORTANT: Generator/contract is source of truth.
// We return CANONICAL metrics keys ONLY (no legacy requests/p95_ms/errors_5xx keys).

import type { ClickhouseTriageInputs, ClickhouseTriageResult } from "./runClickhouseTriage";
import { CANON } from "@/lib/schema/canonical";

// -----------------------------
// Helpers (deterministic mock)
// -----------------------------
function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, 1);
}

function round(n: number) {
  return Math.round(n);
}

function pct(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "n/a";
  return `${n.toFixed(digits)}%`;
}

function ms(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${Math.round(n)} ms`;
}

function int(n: number) {
  if (!Number.isFinite(n)) return "0";
  return `${Math.round(n)}`;
}

function uniqLower(arr: string[]) {
  const out = Array.from(
    new Set(
      arr
        .map((x) => String(x || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function uniqLowerLimit(arr: string[], limit = 24) {
  return uniqLower(arr).slice(0, limit);
}

function stablePick<T>(arr: T[], seed: number, n: number): T[] {
  if (!arr.length) return [];
  const out: T[] = [];
  for (let i = 0; i < Math.min(n, arr.length); i++) {
    const idx = (seed + i * 17) % arr.length;
    out.push(arr[idx]);
  }
  const seen = new Set<any>();
  return out.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

function stableColorKeyList(arr: string[], seed: number, n: number) {
  const uniq = uniqLower(arr);
  const picked = stablePick(uniq, seed, Math.min(n, uniq.length));
  return picked.length ? picked : uniq.slice(0, n);
}

function buildAvailableFromUniverse(universe: {
  regions: string[];
  pops: string[];
  serviceBuckets: string[];
  svcs: string[];
  edgeHosts: string[];
  crcClasses: string[];
  crcs: string[];
  statusCodes: (number | string)[];
  contentTypes: string[];
  uaFamilies: string[];
}) {
  return {
    regions: uniqLower(universe.regions).slice(0, 80),
    pops: uniqLower(universe.pops).slice(0, 120),

    // Step A requirement: serviceBuckets uses canonical services (no "other")
    serviceBuckets: uniqLower(universe.serviceBuckets).slice(0, 24),
    svcs: uniqLower(universe.svcs).slice(0, 24),

    edgeHosts: uniqLower(universe.edgeHosts).slice(0, 48),

    crcClasses: uniqLower(universe.crcClasses).slice(0, 12),
    crcs: uniqLower(universe.crcs).slice(0, 24),
    statusCodes: Array.from(new Set(universe.statusCodes.map((x) => String(x)).filter(Boolean)))
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, 24),

    contentTypes: uniqLowerLimit(universe.contentTypes, 24),
    uaFamilies: uniqLowerLimit(universe.uaFamilies, 24),
  };
}

// ✅ Force parity with CSV: always 5-minute buckets
function chooseBucketSeconds() {
  return 300;
}

// -----------------------------
// Canonical region/POP model (Step A)
// Pops/hosts are derived ONLY from CANON regions+pops.
// -----------------------------
function generateHosts(region: string, pop: string, seed: number, count = 5) {
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = String(((seed + i * 97) % 999) + 1).padStart(3, "0");
    out.push(`edge-${region}-${pop}-${id}`.toLowerCase());
  }
  return out;
}

function buildScopedPopsAndHostsCanon(region: string, pop: string, seed: number) {
  const r = String(region || "all").toLowerCase();
  const p = String(pop || "all").toLowerCase();

  const canonRegions = (CANON.regions as readonly string[]).map(String);
  const canonPops = (CANON.pops as readonly string[]).map(String);

  const effectiveRegion =
    r !== "all" && canonRegions.includes(r) ? r : stablePick(canonRegions, seed, 1)[0] || "us-east";

  let scopedPops: string[] = [];

  if (p !== "all") {
    scopedPops = [p];
  } else {
    const n = seed % 2 === 0 ? 2 : 3;
    scopedPops = stablePick(canonPops, seed + hashToInt(effectiveRegion), n);
  }

  const hostSeries = scopedPops.flatMap((pp, idx) =>
    generateHosts(effectiveRegion, pp, seed + idx * 101, p !== "all" ? 6 : 3)
  );

  return { effectiveRegion, scopedPops, hostSeries };
}

// -----------------------------
// Phase 1 anomalies (unchanged)
// -----------------------------
type AnomalySeverity = "low" | "medium" | "high" | "critical";
type AnomalyHealth = "healthy" | "watch" | "incident";

type AnomalySignal = {
  id: string;
  severity: AnomalySeverity;
  confidence: number; // 0..1
  scope: { service?: string; region?: string; pop?: string };
  time: { startTs: string; endTs: string; buckets: number };
  baseline: { method: "rolling_median_mad"; windowBuckets: number; value: number | null };
  current: { value: number | null; ratio: number | null; z: number | null };
  blastRadius: {
    trafficShare: number; // 0..1
    affectedPops: number;
    affectedHosts: number;
    concentrationTop3Pops: number; // 0..1
  };
  explanation: string;
};

type AnomaliesBlock = {
  health: AnomalyHealth;
  overallConfidence: number; // 0..1
  summary: string;
  signals: AnomalySignal[];
  blastRadius: {
    trafficShare: number;
    affectedPops: number;
    affectedHosts: number;
    concentrationTop3Pops: number;
  };
};

function median(nums: Array<number | null | undefined>) {
  const arr = (nums ?? [])
    .filter((x): x is number => Number.isFinite(x as number))
    .slice()
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function mad(nums: Array<number | null | undefined>, med: number | null) {
  const m = Number.isFinite(med as number) ? (med as number) : median(nums);
  if (m == null) return null;
  const dev = (nums ?? [])
    .filter((x): x is number => Number.isFinite(x as number))
    .map((x) => Math.abs(x - m));
  return median(dev);
}

function rollingBaseline(values: Array<number | null>, idx: number, windowBuckets: number) {
  const start = Math.max(0, idx - windowBuckets);
  const slice = values
    .slice(start, idx)
    .filter((x): x is number => Number.isFinite(x as number));
  if (slice.length < Math.max(3, Math.floor(windowBuckets / 4))) {
    return { baseline: null as number | null, mad: null as number | null, n: slice.length };
  }
  const med = median(slice);
  const m = mad(slice, med);
  return { baseline: med, mad: m, n: slice.length };
}

function consecutiveTrue(flags: boolean[], fromIdx: number, lookback: number) {
  let c = 0;
  for (let i = fromIdx; i >= 0 && c < lookback; i--) {
    if (flags[i]) c++;
    else break;
  }
  return c;
}

function sevRank(sev: AnomalySeverity) {
  if (sev === "critical") return 4;
  if (sev === "high") return 3;
  if (sev === "medium") return 2;
  return 1;
}

function severityFrom(
  kind: "latency" | "error" | "traffic",
  ratio: number,
  currentAbs: number,
  trafficShare: number
): AnomalySeverity {
  if (kind === "latency") {
    if (ratio >= 3 && trafficShare >= 0.2) return "critical";
    if (ratio >= 2 && trafficShare >= 0.1) return "high";
    if (ratio >= 1.6 && trafficShare >= 0.05) return "medium";
    if (ratio >= 1.4) return "low";
    return "low";
  }
  if (kind === "error") {
    if (currentAbs >= 10 && trafficShare >= 0.2) return "critical";
    if (currentAbs >= 5 && trafficShare >= 0.1) return "high";
    if (currentAbs >= 2) return "medium";
    return "low";
  }
  if (ratio >= 2.5 && trafficShare >= 0.2) return "high";
  if (ratio >= 1.8 && trafficShare >= 0.1) return "medium";
  return "low";
}

function computeConfidence(
  strengthScore: number,
  durationScore: number,
  impactScore: number,
  dataQualityScore: number
) {
  const conf =
    0.40 * clamp01(strengthScore) +
    0.25 * clamp01(durationScore) +
    0.25 * clamp01(impactScore) +
    0.10 * clamp01(dataQualityScore);
  return clamp01(conf);
}

function popFromHost(host: string) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return null;
  const parts = h.split("-");
  if (parts.length >= 4 && parts[0] === "edge") {
    const pop = parts[2];
    return pop || null;
  }
  return null;
}

function blastRadiusFromPoints(points: any[], indices: number[], totalWindowRequests: number) {
  const hosts = new Set<string>();
  const pops = new Set<string>();
  const popCounts = new Map<string, number>();

  let affectedReq = 0;

  for (const i of indices) {
    const p = points[i];
    if (!p) continue;

    const req = Number(p.totalRequests) || 0;
    affectedReq += req;

    const hostMap: Record<string, number> = p.hostCountsByHost || {};
    for (const [h, cRaw] of Object.entries(hostMap)) {
      const c = Number(cRaw) || 0;
      if (!h) continue;

      if (h !== "other") {
        hosts.add(h);
        const pop = popFromHost(h);
        if (pop) {
          pops.add(pop);
          popCounts.set(pop, (popCounts.get(pop) ?? 0) + c);
        }
      }
    }
  }

  const trafficShare = totalWindowRequests ? affectedReq / totalWindowRequests : 0;

  const top3 = [...popCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const top3Sum = top3.reduce((s, [, c]) => s + c, 0);
  const concentrationTop3Pops = affectedReq ? top3Sum / affectedReq : 0;

  return {
    trafficShare: clamp01(trafficShare),
    affectedPops: pops.size,
    affectedHosts: hosts.size,
    concentrationTop3Pops: clamp01(concentrationTop3Pops),
  };
}

function computeAnomaliesFromTimeseries(args: {
  points: any[];
  bucketSeconds: number;
  totalWindowRequests: number;
  scope: { service: string; region: string; pop: string };
}): AnomaliesBlock {
  const { points, bucketSeconds, totalWindowRequests, scope } = args;

  if (!points?.length) {
    return {
      health: "healthy",
      overallConfidence: 0,
      summary: "No timeseries points available for anomaly detection.",
      signals: [],
      blastRadius: { trafficShare: 0, affectedPops: 0, affectedHosts: 0, concentrationTop3Pops: 0 },
    };
  }

  const dqScore = 1.0;
  const lookback = Math.min(3, points.length);
  const baselineWindow = Math.min(24, Math.max(6, points.length - lookback));
  const minReqPerBucket = 100;

  const tsMs = points.map((p) => Date.parse(p.ts));
  const p95 = points.map((p) => (Number.isFinite(p?.p95TtmsMs) ? Number(p.p95TtmsMs) : null));
  const errPct = points.map((p) =>
    Number.isFinite(p?.errorRatePct) ? Number(p.errorRatePct) : null
  );
  const traffic = points.map((p) => (Number.isFinite(p?.totalRequests) ? Number(p.totalRequests) : 0));

  const lastIdx = points.length - 1;

  function makeTime(indices: number[]) {
    const msList = indices.map((i) => tsMs[i]).filter((x) => Number.isFinite(x));
    if (!msList.length) {
      const ts = points[lastIdx]?.ts ?? new Date().toISOString();
      return { startTs: ts, endTs: ts, buckets: 1 };
    }
    const s = Math.min(...msList);
    const e = Math.max(...msList);
    return {
      startTs: new Date(s).toISOString(),
      endTs: new Date(e).toISOString(),
      buckets: msList.length,
    };
  }

  const signals: AnomalySignal[] = [];

  // 1) Latency p95 spike
  {
    const flags = new Array(points.length).fill(false);
    const ratios: Array<number | null> = new Array(points.length).fill(null);
    const baselines: Array<number | null> = new Array(points.length).fill(null);
    const mads: Array<number | null> = new Array(points.length).fill(null);

    for (let i = 0; i < points.length; i++) {
      const cur = p95[i];
      const req = traffic[i] || 0;
      if (!Number.isFinite(cur as number) || req < minReqPerBucket) continue;

      const { baseline, mad: m, n } = rollingBaseline(p95, i, baselineWindow);
      if (!Number.isFinite(baseline as number) || (baseline as number) <= 0 || n < 3) continue;

      const ratio = (cur as number) / (baseline as number);
      ratios[i] = ratio;
      baselines[i] = baseline;
      mads[i] = m;

      if (ratio >= 1.6) flags[i] = true;
    }

    const recentIdx: number[] = [];
    for (let i = Math.max(0, lastIdx - (lookback - 1)); i <= lastIdx; i++) recentIdx.push(i);
    const recentTrues = recentIdx.filter((i) => flags[i]);
    const consec = consecutiveTrue(flags, lastIdx, lookback);

    if (recentTrues.length > 0) {
      const focusIdx = consec >= 2 ? recentTrues.slice(-consec) : [recentTrues[recentTrues.length - 1]];

      const i = focusIdx[focusIdx.length - 1];
      const cur = p95[i];
      const base = baselines[i];
      const ratio = ratios[i] ?? (base ? (cur as number) / base : null);

      const br = blastRadiusFromPoints(points, focusIdx, totalWindowRequests);

      const strengthScore = clamp01(((ratio ?? 1) - 1) / 2);
      const durationScore = clamp01((focusIdx.length - 1) / 2);
      const impactScore = clamp01(br.trafficShare / 0.25);

      const confidence = computeConfidence(strengthScore, durationScore, impactScore, dqScore);
      const severity = severityFrom("latency", ratio ?? 1, cur ?? 0, br.trafficShare);

      const z =
        Number.isFinite(mads[i] as number) &&
        (mads[i] as number) > 0 &&
        Number.isFinite(cur as number) &&
        Number.isFinite(base as number)
          ? ((cur as number) - (base as number)) / (1.4826 * (mads[i] as number))
          : null;

      signals.push({
        id: "latency_p95_spike",
        severity,
        confidence,
        scope: { service: scope.service, region: scope.region, pop: scope.pop },
        time: makeTime(focusIdx),
        baseline: { method: "rolling_median_mad", windowBuckets: baselineWindow, value: base },
        current: { value: cur, ratio: ratio ?? null, z: z != null && Number.isFinite(z) ? z : null },
        blastRadius: br,
        explanation: `P95 latency is ${(ratio ?? 1).toFixed(2)}× baseline (${ms(base)} → ${ms(cur ?? null)}).`,
      });
    }
  }

  // 2) Error rate spike
  {
    const flags = new Array(points.length).fill(false);
    const ratios: Array<number | null> = new Array(points.length).fill(null);
    const baselines: Array<number | null> = new Array(points.length).fill(null);

    for (let i = 0; i < points.length; i++) {
      const cur = errPct[i];
      const req = traffic[i] || 0;
      if (!Number.isFinite(cur as number) || req < minReqPerBucket) continue;

      const { baseline, n } = rollingBaseline(errPct, i, baselineWindow);
      if (!Number.isFinite(baseline as number) || n < 3) continue;

      const ratio = ((cur as number) + 0.1) / ((baseline as number) + 0.1);
      ratios[i] = ratio;
      baselines[i] = baseline;

      if (ratio >= 2.0 || (cur as number) >= (baseline as number) + 2.0) flags[i] = true;
    }

    const recentIdx: number[] = [];
    for (let i = Math.max(0, lastIdx - (lookback - 1)); i <= lastIdx; i++) recentIdx.push(i);
    const recentTrues = recentIdx.filter((i) => flags[i]);
    const consec = consecutiveTrue(flags, lastIdx, lookback);

    if (recentTrues.length > 0) {
      const focusIdx = consec >= 2 ? recentTrues.slice(-consec) : [recentTrues[recentTrues.length - 1]];

      const i = focusIdx[focusIdx.length - 1];
      const cur = errPct[i];
      const base = baselines[i];
      const ratio = ratios[i] ?? (base != null && cur != null ? (cur + 0.1) / (base + 0.1) : null);

      const br = blastRadiusFromPoints(points, focusIdx, totalWindowRequests);

      const strengthScore = clamp01(((ratio ?? 1) - 1) / 3);
      const durationScore = clamp01((focusIdx.length - 1) / 2);
      const impactScore = clamp01(br.trafficShare / 0.25);

      const confidence = computeConfidence(strengthScore, durationScore, impactScore, dqScore);
      const severity = severityFrom("error", ratio ?? 1, cur ?? 0, br.trafficShare);

      signals.push({
        id: "error_rate_spike_5xx",
        severity,
        confidence,
        scope: { service: scope.service, region: scope.region, pop: scope.pop },
        time: makeTime(focusIdx),
        baseline: { method: "rolling_median_mad", windowBuckets: baselineWindow, value: base },
        current: { value: cur, ratio: ratio ?? null, z: null },
        blastRadius: br,
        explanation: `5xx error rate is elevated (${pct(base ?? 0)} → ${pct(cur ?? 0)}).`,
      });
    }
  }

  // 3) Traffic drop
  {
    const flags = new Array(points.length).fill(false);
    const ratios: Array<number | null> = new Array(points.length).fill(null);
    const baselines: Array<number | null> = new Array(points.length).fill(null);

    for (let i = 0; i < points.length; i++) {
      const cur = traffic[i] || 0;

      const { baseline, n } = rollingBaseline(traffic, i, baselineWindow);
      if (!Number.isFinite(baseline as number) || (baseline as number) <= 0 || n < 3) continue;

      baselines[i] = baseline;

      const ratio = (baseline as number) / Math.max(1, cur);
      ratios[i] = ratio;

      if (cur <= (baseline as number) * 0.6) flags[i] = true;
    }

    const recentIdx: number[] = [];
    for (let i = Math.max(0, lastIdx - (lookback - 1)); i <= lastIdx; i++) recentIdx.push(i);
    const recentTrues = recentIdx.filter((i) => flags[i]);
    const consec = consecutiveTrue(flags, lastIdx, lookback);

    if (recentTrues.length > 0) {
      const focusIdx = consec >= 2 ? recentTrues.slice(-consec) : [recentTrues[recentTrues.length - 1]];

      const i = focusIdx[focusIdx.length - 1];
      const cur = traffic[i] || 0;
      const base = baselines[i];
      const ratio = ratios[i] ?? (base ? base / Math.max(1, cur) : null);

      const br = blastRadiusFromPoints(points, focusIdx, totalWindowRequests);

      const strengthScore = clamp01(((ratio ?? 1) - 1) / 2);
      const durationScore = clamp01((focusIdx.length - 1) / 2);
      const impactScore = clamp01(br.trafficShare / 0.25);

      const confidence = computeConfidence(strengthScore, durationScore, impactScore, dqScore);
      const severity = severityFrom("traffic", ratio ?? 1, cur ?? 0, br.trafficShare);

      signals.push({
        id: "traffic_drop",
        severity,
        confidence,
        scope: { service: scope.service, region: scope.region, pop: scope.pop },
        time: makeTime(focusIdx),
        baseline: { method: "rolling_median_mad", windowBuckets: baselineWindow, value: base },
        current: { value: cur, ratio: ratio ?? null, z: null },
        blastRadius: br,
        explanation: `Traffic dropped vs baseline (${int(base ?? 0)} → ${int(cur)} req/bucket).`,
      });
    }
  }

  const overallConfidence = clamp01(signals.reduce((m, s) => Math.max(m, s.confidence), 0));

  const hasIncidentSignal = signals.some(
    (s) =>
      (s.severity === "high" || s.severity === "critical") &&
      s.confidence >= 0.7 &&
      s.blastRadius.trafficShare >= 0.1
  );
  const hasWatchSignal = signals.some((s) => s.confidence >= 0.5);

  const health: AnomalyHealth = hasIncidentSignal ? "incident" : hasWatchSignal ? "watch" : "healthy";

  const top = [...signals].sort((a, b) => {
    const r = sevRank(b.severity) - sevRank(a.severity);
    if (r !== 0) return r;
    return b.confidence - a.confidence;
  })[0];

  const summary = top
    ? `${health.toUpperCase()}: ${top.explanation} (confidence ${(top.confidence * 100).toFixed(
        0
      )}%, traffic ${(top.blastRadius.trafficShare * 100).toFixed(0)}%).`
    : "HEALTHY: No anomalies detected in the last few buckets.";

  const overallBR = top
    ? top.blastRadius
    : { trafficShare: 0, affectedPops: 0, affectedHosts: 0, concentrationTop3Pops: 0 };

  return {
    health,
    overallConfidence,
    summary,
    signals,
    blastRadius: overallBR,
  };
}

// -----------------------------
// Mock runner (Step A aligned)
// -----------------------------
export async function runMockClickhouseTriage(
  inputs: ClickhouseTriageInputs
): Promise<ClickhouseTriageResult> {
  const {
    partner,
    service,
    region,
    pop,
    contentType = "all",
    uaFamily = "all",
    windowMinutes,
    debug,
  } = inputs;

  const seed = hashToInt(
    `${partner}|${service}|${region}|${pop}|${contentType}|${uaFamily}|${windowMinutes}`
  );

  const baseTraffic = 5000 + (seed % 25000);
  const noise = (seed % 1000) / 1000;

  const canonRegions = (CANON.regions as readonly string[]).map(String);
  const canonPops = (CANON.pops as readonly string[]).map(String);
  const canonServices = (CANON.services as readonly string[]).map(String);
  const canonContentTypes = (CANON.contentTypes as readonly string[]).map(String);
  const canonUaFamilies = (CANON.uaFamilies as readonly string[]).map(String);

  const crcUniverse = [
    "TCP_HIT",
    "TCP_MISS",
    "TCP_CF_HIT",
    "ERR_TIMEOUT",
    "ERR_DNS",
    "TCP_CLIENT_REFRESH",
    "ERR_CONN_RESET",
    "ERR_ORIGIN_5XX",
  ];
  const crcClassUniverse = ["hit", "miss", "client", "error", "other"];
  const statusUniverse = [200, 206, 304, 403, 404, 429, 500, 502, 503, 504];

  const { effectiveRegion, scopedPops, hostSeries } = buildScopedPopsAndHostsCanon(region, pop, seed);

  const available = buildAvailableFromUniverse({
    regions: canonRegions,
    pops: canonPops,
    serviceBuckets: canonServices,
    svcs: canonServices,
    edgeHosts: hostSeries,
    crcClasses: crcClassUniverse,
    crcs: crcUniverse,
    statusCodes: statusUniverse,
    contentTypes: canonContentTypes,
    uaFamilies: canonUaFamilies,
  });

  const bucketSeconds = chooseBucketSeconds(); // 300
  const bucketMs = bucketSeconds * 1000;

  const nowMs = Date.now();
  const endAlignedMs = Math.floor(nowMs / bucketMs) * bucketMs;

  const spanMinutes = Math.max(1, windowMinutes);
  const spanBuckets = Math.max(1, Math.ceil((spanMinutes * 60) / bucketSeconds));

  const startAlignedMs = endAlignedMs - spanBuckets * bucketMs;

  const startISO = new Date(startAlignedMs).toISOString();
  const endISO = new Date(endAlignedMs).toISOString();

  const baseErrorPct =
    (service === "live" ? 0.9 : service === "vod" ? 0.5 : 0.7) + noise * 1.2;

  const baseP50 = (service === "live" ? 120 : service === "vod" ? 160 : 140) + (seed % 80);
  const baseP95 = (service === "live" ? 180 : service === "vod" ? 240 : 210) + (seed % 120);
  const baseP99 = baseP95 + 120 + (seed % 180);

  let totalRequests = 0;
  let total5xx = 0;

  const p50Samples: number[] = [];
  const p95Samples: number[] = [];
  const p99Samples: number[] = [];

  const statusCodeSeries = statusUniverse.map(String);
  const crcSeries = crcUniverse.map((c) => String(c).toUpperCase()).slice(0, 10);

  const points: Array<{
    ts: string;
    totalRequests: number;
    error5xxCount: number;
    errorRatePct: number;
    p50TtmsMs: number;
    p95TtmsMs: number;
    p99TtmsMs: number;
    statusCountsByCode: Record<string, number>;
    hostCountsByHost: Record<string, number>;
    crcCountsByCrc: Record<string, number>;
  }> = [];

  const forceAnomaly = !!debug;
  const forcedBuckets = 8; // 40 minutes

  const hostSeriesOrdered = stableColorKeyList(hostSeries, seed, Math.min(18, hostSeries.length));

  for (let bi = 0; bi <= spanBuckets; bi++) {
    const t = startAlignedMs + bi * bucketMs;

    const wave = 0.75 + 0.5 * Math.sin((bi / Math.max(8, spanBuckets)) * Math.PI * 2);

    let req = round(((baseTraffic * wave * (0.6 + noise * 0.8)) / (spanBuckets + 1)) * 60);
    req = Math.max(req, 250);

    const isForcedRange = forceAnomaly && bi >= Math.max(0, spanBuckets - (forcedBuckets - 1));

    const randomErrSpike = seed % 7 === 0 && bi > Math.floor(spanBuckets * 0.75) ? 2.5 : 1.0;
    const randomP95Spike = seed % 11 === 0 && bi > Math.floor(spanBuckets * 0.8) ? 2.2 : 1.0;

    const errSpike = isForcedRange ? 6.0 : randomErrSpike;
    const pSpike = isForcedRange ? 2.8 : randomP95Spike;

    const errPct = clamp(baseErrorPct * errSpike * (0.75 + 0.5 * Math.cos(bi / 3)), 0, 35);
    const err5xx = round((req * errPct) / 100);

    const p50 = round(baseP50 * Math.max(1.0, pSpike * 0.75) * (0.9 + 0.25 * Math.sin(bi / 6)));
    const p95 = round(baseP95 * pSpike * (0.9 + 0.25 * Math.sin(bi / 5)));
    const p99 = round(baseP99 * Math.max(1.0, pSpike * 0.9) * (0.9 + 0.25 * Math.cos(bi / 6)));

    totalRequests += req;
    total5xx += err5xx;

    p50Samples.push(p50);
    p95Samples.push(p95);
    p99Samples.push(p99);

    const statusCountsByCode: Record<string, number> = {};
    const hostCountsByHost: Record<string, number> = {};
    const crcCountsByCrc: Record<string, number> = {};

    const s200 = round(req * 0.78);
    const s206 = round(req * 0.12);
    const s304 = round(req * 0.03);
    const s4xx = round(req * 0.03);
    const s5xx = Math.max(0, err5xx);

    statusCountsByCode["200"] = s200;
    statusCountsByCode["206"] = s206;
    statusCountsByCode["304"] = s304;
    statusCountsByCode["403"] = round(s4xx * 0.25);
    statusCountsByCode["404"] = round(s4xx * 0.35);
    statusCountsByCode["429"] = Math.max(0, s4xx - statusCountsByCode["403"] - statusCountsByCode["404"]);
    statusCountsByCode["500"] = round(s5xx * 0.22);
    statusCountsByCode["502"] = round(s5xx * 0.18);
    statusCountsByCode["503"] = round(s5xx * 0.35);
    statusCountsByCode["504"] = Math.max(
      0,
      s5xx - statusCountsByCode["500"] - statusCountsByCode["502"] - statusCountsByCode["503"]
    );

    let remainingHost = req;
    for (let hi = 0; hi < hostSeriesOrdered.length; hi++) {
      const baseShare = 0.18 - hi * 0.02;
      const share =
        hi === hostSeriesOrdered.length - 1
          ? remainingHost
          : round(req * clamp(baseShare, 0.04, 0.18));
      const v = clamp(share, 0, remainingHost);
      hostCountsByHost[hostSeriesOrdered[hi]] = v;
      remainingHost -= v;
      if (remainingHost <= 0) break;
    }
    if (remainingHost > 0) {
      hostCountsByHost["other"] = (hostCountsByHost["other"] ?? 0) + remainingHost;
    }

    const hit = round(req * 0.7);
    const miss = round(req * 0.1);
    const client = round(req * 0.02);
    const errs = Math.max(0, err5xx);

    crcCountsByCrc["TCP_HIT"] = hit;
    crcCountsByCrc["TCP_MISS"] = miss;
    crcCountsByCrc["TCP_CLIENT_REFRESH"] = client;
    crcCountsByCrc["ERR_TIMEOUT"] = round(errs * 0.42);
    crcCountsByCrc["ERR_DNS"] = round(errs * 0.18);
    crcCountsByCrc["ERR_CONN_RESET"] = round(errs * 0.12);
    crcCountsByCrc["ERR_ORIGIN_5XX"] = Math.max(
      0,
      errs -
        crcCountsByCrc["ERR_TIMEOUT"] -
        crcCountsByCrc["ERR_DNS"] -
        crcCountsByCrc["ERR_CONN_RESET"]
    );

    points.push({
      ts: new Date(t).toISOString(),
      totalRequests: req,
      error5xxCount: err5xx,
      errorRatePct: req ? (err5xx / req) * 100 : 0,
      p50TtmsMs: p50,
      p95TtmsMs: p95,
      p99TtmsMs: p99,
      statusCountsByCode,
      hostCountsByHost,
      crcCountsByCrc,
    });
  }

  const sortedP50 = [...p50Samples].sort((a, b) => a - b);
  const sortedP95 = [...p95Samples].sort((a, b) => a - b);
  const sortedP99 = [...p99Samples].sort((a, b) => a - b);

  const p50TtmsMs =
    sortedP50.length ? round(sortedP50[Math.floor(sortedP50.length * 0.5)]) : 0;
  const p95TtmsMs =
    sortedP95.length ? round(sortedP95[Math.floor(sortedP95.length * 0.95)]) : 0;
  const p99TtmsMs =
    sortedP99.length ? round(sortedP99[Math.floor(sortedP99.length * 0.99)]) : 0;

  const cacheHitPct =
    service === "vod" ? clamp(82 + (seed % 12) - noise * 4, 20, 99) : clamp(68 + (seed % 18) - noise * 6, 10, 95);
  const cacheMissPct = clamp(100 - cacheHitPct, 0, 100);

  const statusCounts = [
    { code: 200, count: round(totalRequests * 0.78) },
    { code: 206, count: round(totalRequests * 0.12) },
    { code: 304, count: round(totalRequests * 0.03) },
    { code: 403, count: round(totalRequests * 0.01) },
    { code: 404, count: round(totalRequests * 0.01) },
    { code: 429, count: round(totalRequests * 0.01) },
    { code: 500, count: round(total5xx * 0.22) },
    { code: 502, count: round(total5xx * 0.18) },
    { code: 503, count: round(total5xx * 0.35) },
    { code: 504, count: round(total5xx * 0.25) },
  ].filter((x) => x.count > 0);

  const topCrcClass = [
    { crc_class: "hit", count: round(totalRequests * (cacheHitPct / 100) * 0.95) },
    { crc_class: "miss", count: round(totalRequests * (cacheMissPct / 100) * 0.85) },
    { crc_class: "client", count: round(totalRequests * 0.02) },
    { crc_class: "error", count: round(total5xx * 0.75) },
  ].filter((x) => x.count > 0);

  const topErrorCrc = [
    { crc: "ERR_TIMEOUT", count: round(total5xx * 0.42) },
    { crc: "ERR_DNS", count: round(total5xx * 0.18) },
    { crc: "ERR_CONN_RESET", count: round(total5xx * 0.12) },
    { crc: "ERR_ORIGIN_5XX", count: round(total5xx * 0.28) },
  ].filter((x) => x.count > 0);

  // ✅ CANONICAL: always number
  const errorRatePct = totalRequests ? (total5xx / totalRequests) * 100 : 0;

  const anomalies = computeAnomaliesFromTimeseries({
    points,
    bucketSeconds,
    totalWindowRequests: totalRequests,
    scope: { service, region, pop },
  });

  const warnings: string[] = [];
  if (totalRequests === 0) warnings.push("No rows matched (mock produced 0 requests).");
  if (debug) warnings.push(`debug=true: forcing anomalies in last ${forcedBuckets} buckets for UI testing.`);

  const summaryText = [
    `🧭 *CDN TRIAGE SUMMARY*`,
    `• Source: \`clickhouse (mock)\` • partner=\`${partner}\``,
    `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``,
    `• Filters: contentType=\`${contentType}\` uaFamily=\`${uaFamily}\``,
    `• Window: \`${windowMinutes}m\`  • Time (UTC): \`${startISO}\` → \`${endISO}\``,
    ...(anomalies?.signals?.length
      ? [
          "",
          `🚨 *Anomalies*`,
          `• Health: *${anomalies.health.toUpperCase()}* (confidence ${(anomalies.overallConfidence * 100).toFixed(0)}%)`,
          `• ${anomalies.summary}`,
        ]
      : []),
    ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
    "",
    `📊 *Traffic & Performance*`,
    `• Requests: *${int(totalRequests)}*`,
    `• P95 TTMS: *${ms(p95TtmsMs)}*`,
    `• P99 TTMS: *${ms(p99TtmsMs)}*`,
    `• Cache Hit: *${pct(cacheHitPct)}*  (miss ${pct(cacheMissPct)})`,
    "",
    `🧮 *Response Codes*`,
    ...statusCounts.slice(0, 10).map((s) => `• ${s.code}: *${s.count}*`),
    "",
    `🧾 *Evidence*`,
    `• Error responses: ${int(total5xx)}/${int(totalRequests)} (${pct(errorRatePct)}).`,
    "",
    `🔧 *Mock scope*`,
    `• effectiveRegion(for hosts)=\`${effectiveRegion}\``,
    `• scopedPops(for hosts)=\`${scopedPops.join(", ")}\``,
  ].join("\n");

  const sql =
    debug
      ? {
          queries: [
            [
              `-- MOCK SQL (public-safe)`,
              `-- Partner: ${partner}`,
              `-- Filters: service=${service}, region=${region}, pop=${pop}, contentType=${contentType}, uaFamily=${uaFamily}, windowMinutes=${windowMinutes}`,
              `SELECT`,
              `  toStartOfInterval(ts, INTERVAL ${bucketSeconds} SECOND) AS bucket,`,
              `  count() AS totalRequests,`,
              `  countIf(edge_status >= 500 AND edge_status < 600) AS error5xxCount,`,
              `  quantileExact(0.50)(ttms_ms) AS p50TtmsMs,`,
              `  quantileExact(0.95)(ttms_ms) AS p95TtmsMs,`,
              `  quantileExact(0.99)(ttms_ms) AS p99TtmsMs`,
              `FROM edge_logs`,
              `WHERE partner = '${partner}'`,
              `  AND ts >= now() - INTERVAL ${windowMinutes} MINUTE`,
              `  AND service_bucket = '${service}'`,
              `  AND ('${region}' = 'all' OR region = '${region}')`,
              `  AND ('${pop}' = 'all' OR pop = '${pop}')`,
              `  AND ('${contentType}' = 'all' OR content_type = '${contentType}')`,
              `  AND ('${uaFamily}' = 'all' OR ua_family = '${uaFamily}')`,
              `GROUP BY bucket`,
              `ORDER BY bucket ASC;`,
            ].join("\n"),
          ],
        }
      : undefined;

  // ✅ CANONICAL METRICS SHAPE (no legacy keys)
  const metricsJson = {
    available,
    timeRangeUTC: { start: startISO, end: endISO },

    // REQUIRED canonical keys
    totalRequests,
    p50TtmsMs,
    p95TtmsMs,
    p99TtmsMs,
    error5xxCount: total5xx,
    errorRatePct,

    // optional but useful (UI can use these)
    cacheHitPct,
    cacheMissPct,
    statusCounts,
    topCrcClass,
    topErrorCrc,

    timeseries: {
      bucketSeconds,
      startTs: points.length ? points[0].ts : startISO,
      endTs: points.length ? points[points.length - 1].ts : endISO,
      points,
      statusCodeSeries,
      hostSeries: hostSeriesOrdered,
      crcSeries,
    },

    anomalies,
    warnings,

    dataQuality: {
      all: {
        invalid_ts: 0,
        missing_edge_status: 0,
        unknown_service: 0,
        unknown_crc: 0,
        unknown_region: 0,
        unknown_pop: 0,
        unknown_svc: 0,
        unknown_edge_host: 0,
      },
      window: {
        invalid_ts: 0,
        missing_edge_status: 0,
        unknown_service: 0,
        unknown_crc: 0,
        unknown_region: 0,
        unknown_pop: 0,
        unknown_svc: 0,
        unknown_edge_host: 0,
      },
    },

    // ✅ debug must ALWAYS be an object (never null)
    debug: {
      source: "clickhouse_mock",
      forcedAnomaly: !!forceAnomaly,
      effectiveRegion,
      scopedPops,
      note: "ClickHouse mock runner (no real DB access).",
    },
  };

  return {
    summary: summaryText,
    summaryText,
    metricsJson,
    sql,
  };
}