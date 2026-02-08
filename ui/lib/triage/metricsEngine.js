// lib/triage/metricsEngine.js
// Ported from n8n Function node to a plain JS module.
// Returns { summaryText, metricsJson }.

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function normLower(v) {
  return String(v ?? "").trim().toLowerCase();
}
function normUpper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function matchDim(value, expected, dimName = "unknown") {
  if (!expected || expected === "all") return true;
  const valNorm = normLower(value);
  const expNorm = normLower(expected);
  return valNorm === expNorm;
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function formatPct(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(digits)}%`;
}

function formatMs(x) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${Math.round(x)} ms`;
}

function formatInt(x) {
  if (x == null || !Number.isFinite(x)) return "0";
  return `${Math.round(x)}`;
}

function prettyFilters(filters) {
  if (!filters?.length) return "none";
  return filters
    .map((f) => {
      if (f?.type === "range") return `${f.key}=${f.min}-${f.max}`;
      if (f?.type === "eq") return `${f.key}=${f.value}`;
      if (f?.type === "in")
        return `${f.key} in (${(f.values ?? []).join(",")})`;
      return `${f?.key ?? "filter"}`;
    })
    .join(", ");
}

function topCounts(rows, key, limit = 6) {
  const counts = new Map();
  for (const r of rows) {
    const v = String(r?.[key] ?? "").trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function topKeys(rows, key, limit = 24) {
  return topCounts(rows, key, limit)
    .map(([v]) => String(v).trim())
    .filter(Boolean);
}

function topValuesPretty(rows, key, limit = 6) {
  const entries = topCounts(rows, key, limit);
  if (!entries.length) return "n/a";
  return entries.map(([v, c]) => `${v} (${c})`).join(", ");
}

/**
 * Robust hostname parser:
 * - Accepts full URL OR hostname OR hostname/path
 * - Extracts:
 *   - edge_host: first DNS label
 *   - svc: hostname without first label (suffix host)
 *   - region/pop: best-effort
 *     - cdn-<tier>-<site>-<node> => region=site, pop=site-node
 *     - legacy edge-<region>-<pop> => region/pop from pattern
 */
function deriveHostSvcRegionPopFromUrl(u) {
  const s = String(u || "").trim();
  if (!s)
    return {
      edge_host: null,
      svc: null,
      region: null,
      pop: null,
      hostname: null,
    };

  const hasScheme = /^[a-z]+:\/\//i.test(s);

  let hostname = "";
  try {
    const url = new URL(hasScheme ? s : `https://${s}`);
    hostname = url.hostname || "";
  } catch {
    hostname = (s.split("/")[0] || "")
      .split("?")[0]
      .split("#")[0]
      .trim();
  }

  if (!hostname)
    return {
      edge_host: null,
      svc: null,
      region: null,
      pop: null,
      hostname: null,
    };

  const parts = hostname.split(".");
  const edge_host = parts[0] || null;
  const svc = parts.length > 1 ? parts.slice(1).join(".") : null;

  let region = null;
  let pop = null;

  // cdn-<tier>-<site>-<node>
  const m = String(edge_host).match(
    /^cdn-([a-z]{2,4})-([a-z]{2,8})-([a-z0-9]+)(?:-.+)?$/i
  );
  if (m) {
    const site = (m[2] || "").toLowerCase();
    const node = (m[3] || "").toLowerCase();
    region = site;
    pop = `${site}-${node}`;
  }

  // legacy edge-<region>-<pop>
  if (!region || !pop) {
    const m2 = hostname.match(/(^|\.)edge-([a-z0-9]+)-([a-z0-9]+)\b/i);
    if (m2) {
      region = m2[2].toLowerCase();
      pop = m2[3].toLowerCase();
    }
  }

  return { edge_host, svc, region, pop, hostname };
}

function normalizeIsoToMsUtc(ts) {
  if (!ts) return null;
  let s = String(ts).trim();
  if (!s) return null;

  const hasTZ = /Z$|[+-]\d\d:\d\d$/.test(s);
  const m = s.match(/^(.+?)(\.(\d+))?(Z|[+-]\d\d:\d\d)?$/);
  if (!m) return null;

  const base = m[1];
  const frac = m[3] ?? "";
  const tz = m[4] ?? (hasTZ ? "" : "Z");

  const ms = (frac + "000").slice(0, 3);
  const iso = `${base}.${ms}${tz || "Z"}`;
  return iso;
}

function toMs(ts) {
  const iso = normalizeIsoToMsUtc(ts);
  if (!iso) return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

function deriveCrcClass(crcRaw) {
  const c = normUpper(crcRaw);
  if (!c || c === "UNKNOWN") return "unknown";
  if (c.startsWith("ERR_")) return "error";

  if (
    ["TCP_HIT", "TCP_CF_HIT", "TCP_REF_FAIL_HIT", "TCP_REFRESH_HIT"].includes(c)
  )
    return "hit";
  if (["TCP_MISS", "TCP_REFRESH_MISS"].includes(c)) return "miss";
  if (["TCP_CLIENT_REFRESH"].includes(c)) return "client";

  return "other";
}

// ✅ service bucket so UI service=live|vod works even if CSV has different fields
function deriveServiceBucket(row) {
  const s = normLower(row?.service);
  const svc = normLower(row?.svc);

  if (s === "live" || s === "vod") return s;

  const hay = `${s} ${svc}`;

  if (/\blive\b/.test(hay)) return "live";
  if (/\bvod\b/.test(hay) || /\bipvod\b/.test(hay) || /\bvod-/.test(hay))
    return "vod";

  return "other";
}

function passesFilter(row, f) {
  if (!f || !f.key) return true;
  const v = row[f.key];

  if (f.type === "range") {
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
    const minOk = f.min == null ? true : n >= Number(f.min);
    const maxOk = f.max == null ? true : n <= Number(f.max);
    return minOk && maxOk;
  }

  if (f.type === "eq") {
    const a = String(v ?? "").trim().toLowerCase();
    const b = String(f.value ?? "").trim().toLowerCase();
    return a === b;
  }

  if (f.type === "in") {
    const a = String(v ?? "").trim().toLowerCase();
    const set = (f.values ?? []).map((x) => String(x).trim().toLowerCase());
    return set.includes(a);
  }

  return true;
}

function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const v = r?.[key];
    if (v == null || v === "" || Number.isNaN(v)) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

function prettyStatusCounts(statusCounts, limit = 12) {
  if (!statusCounts.length) return "n/a";
  return statusCounts
    .slice(0, limit)
    .map(([code, count]) => `• ${code}: *${count}*`)
    .join("\n");
}

// ------------------------------------------------------------
// Timeseries helpers
// ------------------------------------------------------------

// ✅ Force 5-minute buckets for BOTH csv + clickhouse parity
function chooseBucketSeconds() {
  return 300; // 5 minutes
}

function percentileSorted(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

// Build a stable series list from points’ count maps
function unionSeriesFromPoints(points, key, limit = 12) {
  const totals = new Map();
  for (const p of points) {
    const m = p?.[key] || {};
    for (const k of Object.keys(m)) {
      totals.set(k, (totals.get(k) ?? 0) + Number(m[k] ?? 0));
    }
  }
  return [...totals.entries()]
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, limit)
    .map(([k]) => String(k));
}

function buildTimeseriesPoints(rows) {
  const bucketSeconds = chooseBucketSeconds();
  const bucketMs = bucketSeconds * 1000;

  const buckets = new Map();
  let minMs = null;
  let maxMs = null;

  for (const r of rows) {
    const t = toMs(r.ts);
    if (Number.isNaN(t)) continue;

    if (minMs == null || t < minMs) minMs = t;
    if (maxMs == null || t > maxMs) maxMs = t;

    const b = Math.floor(t / bucketMs) * bucketMs;

    let acc = buckets.get(b);
    if (!acc) {
      acc = {
        total: 0,
        err5xx: 0,
        ttms: [],
        statusCountsByCode: {},
        hostCountsByHost: {},
        crcCountsByCrc: {},
      };
      buckets.set(b, acc);
    }

    acc.total += 1;

    const edgeStatus = Number(r.edge_status);
    if (Number.isFinite(edgeStatus)) {
      const codeKey = String(edgeStatus);
      acc.statusCountsByCode[codeKey] =
        (acc.statusCountsByCode[codeKey] ?? 0) + 1;

      if (edgeStatus >= 500 && edgeStatus < 600) acc.err5xx += 1;
    }

    const host = String(r.edge_host ?? "").trim().toLowerCase();
    if (host) {
      acc.hostCountsByHost[host] = (acc.hostCountsByHost[host] ?? 0) + 1;
    }

    const crc = String(r.crc ?? "").trim().toUpperCase();
    if (crc) {
      acc.crcCountsByCrc[crc] = (acc.crcCountsByCrc[crc] ?? 0) + 1;
    }

    const ttms = Number(r.ttms_ms);
    if (Number.isFinite(ttms)) acc.ttms.push(ttms);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);

  const points = keys.map((k) => {
    const acc = buckets.get(k);
    const tt = acc?.ttms ?? [];
    tt.sort((a, b) => a - b);

    const p95 = percentileSorted(tt, 0.95);
    const p99 = percentileSorted(tt, 0.99);
    const errorRatePct = acc.total ? (acc.err5xx / acc.total) * 100 : 0;

    return {
      ts: new Date(k).toISOString(),
      totalRequests: acc.total,
      error5xxCount: acc.err5xx,
      errorRatePct,
      p95TtmsMs: p95,
      p99TtmsMs: p99,

      // ✅ stacked-series payloads
      statusCountsByCode: acc.statusCountsByCode,
      hostCountsByHost: acc.hostCountsByHost,
      crcCountsByCrc: acc.crcCountsByCrc,
    };
  });

  // Stable legend ordering
  const statusCodeSeries = unionSeriesFromPoints(points, "statusCountsByCode", 24).sort(
    (a, b) => Number(a) - Number(b)
  );

  const hostSeries = unionSeriesFromPoints(points, "hostCountsByHost", 10); // top 10 hosts
  const crcSeries = unionSeriesFromPoints(points, "crcCountsByCrc", 10); // top 10 crc codes

  const startTs =
    minMs == null
      ? null
      : new Date(Math.floor(minMs / bucketMs) * bucketMs).toISOString();
  const endTs =
    maxMs == null
      ? null
      : new Date(Math.floor(maxMs / bucketMs) * bucketMs).toISOString();

  return {
    bucketSeconds,
    startTs,
    endTs,
    points,
    statusCodeSeries,
    hostSeries,
    crcSeries,
  };
}

function emptyTimeseries() {
  return {
    bucketSeconds: null,
    startTs: null,
    endTs: null,
    points: [],
    statusCodeSeries: [],
    hostSeries: [],
    crcSeries: [],
  };
}

// ------------------------------------------------------------
// Phase 1 Anomaly Detection + Confidence
// ------------------------------------------------------------
function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function median(nums) {
  const arr = (nums ?? [])
    .filter((x) => Number.isFinite(x))
    .slice()
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function mad(nums, med) {
  const m = Number.isFinite(med) ? med : median(nums);
  if (m == null) return null;
  const dev = (nums ?? [])
    .filter((x) => Number.isFinite(x))
    .map((x) => Math.abs(x - m));
  return median(dev);
}

function rollingBaseline(values, idx, windowBuckets) {
  const start = Math.max(0, idx - windowBuckets);
  const slice = values.slice(start, idx).filter((x) => Number.isFinite(x));
  if (slice.length < Math.max(3, Math.floor(windowBuckets / 4))) {
    return { baseline: null, mad: null, n: slice.length };
  }
  const med = median(slice);
  const m = mad(slice, med);
  return { baseline: med, mad: m, n: slice.length };
}

function consecutiveTrue(flags, fromIdx, lookback) {
  // counts consecutive true ending at fromIdx, checking at most lookback elements
  let c = 0;
  for (let i = fromIdx; i >= 0 && c < lookback; i--) {
    if (flags[i]) c++;
    else break;
  }
  return c;
}

function severityFrom({ kind, ratio, currentAbs, trafficShare }) {
  // Simple, predictable rules
  if (kind === "latency") {
    if (ratio >= 3 && trafficShare >= 0.2) return "critical";
    if (ratio >= 2 && trafficShare >= 0.1) return "high";
    if (ratio >= 1.6 && trafficShare >= 0.05) return "medium";
    if (ratio >= 1.4) return "low";
    return "low";
  }
  if (kind === "error") {
    // currentAbs is errorRatePct
    if (currentAbs >= 10 && trafficShare >= 0.2) return "critical";
    if (currentAbs >= 5 && trafficShare >= 0.1) return "high";
    if (currentAbs >= 2) return "medium";
    return "low";
  }
  if (kind === "traffic") {
    // ratio means baseline/current (drop severity)
    if (ratio >= 2.5 && trafficShare >= 0.2) return "high";
    if (ratio >= 1.8 && trafficShare >= 0.1) return "medium";
    return "low";
  }
  return "low";
}

function computeConfidence({ strengthScore, durationScore, impactScore, dataQualityScore }) {
  const conf =
    0.40 * clamp01(strengthScore) +
    0.25 * clamp01(durationScore) +
    0.25 * clamp01(impactScore) +
    0.10 * clamp01(dataQualityScore);
  return clamp01(conf);
}

function dataQualityScoreFrom(dqWindow, totalRows) {
  const total = Math.max(1, Number(totalRows) || 1);
  const bad =
    (dqWindow?.invalid_ts ?? 0) +
    (dqWindow?.missing_edge_status ?? 0) +
    (dqWindow?.unknown_region ?? 0) +
    (dqWindow?.unknown_pop ?? 0);
  const badRatio = bad / total;
  return clamp01(1 - badRatio * 2); // degrade faster; if 25% bad => ~0.5
}

function buildBucketIndex(rows, bucketSeconds) {
  const bucketMs = bucketSeconds * 1000;
  const idx = new Map(); // bucketMs -> { total, pops:Map, hosts:Map }
  let total = 0;

  for (const r of rows) {
    const t = toMs(r.ts);
    if (!Number.isFinite(t)) continue;
    const b = Math.floor(t / bucketMs) * bucketMs;

    let acc = idx.get(b);
    if (!acc) {
      acc = { total: 0, pops: new Map(), hosts: new Map() };
      idx.set(b, acc);
    }

    acc.total += 1;
    total += 1;

    const pop = String(r.pop ?? "").trim().toLowerCase();
    if (pop) acc.pops.set(pop, (acc.pops.get(pop) ?? 0) + 1);

    const host = String(r.edge_host ?? "").trim().toLowerCase();
    if (host) acc.hosts.set(host, (acc.hosts.get(host) ?? 0) + 1);
  }

  return { idx, total };
}

function blastRadiusForBuckets(bucketIndex, bucketMsList, totalRows) {
  const pops = new Set();
  const hosts = new Set();
  let affected = 0;

  const popCounts = new Map();

  for (const b of bucketMsList) {
    const acc = bucketIndex.get(b);
    if (!acc) continue;
    affected += acc.total;

    for (const [p, c] of acc.pops.entries()) {
      pops.add(p);
      popCounts.set(p, (popCounts.get(p) ?? 0) + c);
    }
    for (const h of acc.hosts.keys()) {
      hosts.add(h);
    }
  }

  const trafficShare = totalRows ? affected / totalRows : 0;

  const top3 = [...popCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const top3Sum = top3.reduce((s, [, c]) => s + c, 0);
  const concentrationTop3Pops = affected ? top3Sum / affected : 0;

  return {
    affectedCount: affected,
    trafficShare: clamp01(trafficShare),
    affectedPops: pops.size,
    affectedHosts: hosts.size,
    concentrationTop3Pops: clamp01(concentrationTop3Pops),
  };
}

// ✅ user-friendly + SRE-level formatting helpers
function fmtShare(x) {
  if (!Number.isFinite(x)) return "0%";
  return `${Math.round(x * 100)}%`;
}
function fmtConfidence(x) {
  if (!Number.isFinite(x)) return "0%";
  return `${Math.round(x * 100)}%`;
}
function fmtDurationBuckets(buckets, bucketSeconds) {
  const b = Math.max(1, Number(buckets) || 1);
  const mins = (b * (Number(bucketSeconds) || 300)) / 60;
  if (mins >= 120) return `${Math.round(mins / 60)}h`;
  if (mins >= 60) return `${(mins / 60).toFixed(1)}h`;
  return `${Math.round(mins)}m`;
}

function computeAnomalies({ timeseries, filteredRows, dqWindow, scope }) {
  const points = timeseries?.points ?? [];
  const bucketSeconds = Number(timeseries?.bucketSeconds) || chooseBucketSeconds();

  if (!points.length) {
    return {
      health: "healthy",
      overallConfidence: 0,
      summary: "No timeseries points available for anomaly detection.",
      signals: [],
      blastRadius: {
        trafficShare: 0,
        affectedPops: 0,
        affectedHosts: 0,
        concentrationTop3Pops: 0,
      },
    };
  }

  const totalRows = filteredRows?.length ?? 0;
  const dqScore = dataQualityScoreFrom(dqWindow, totalRows);

  // Prepare arrays
  const tsMs = points.map((p) => Date.parse(p.ts));
  const p95 = points.map((p) =>
    Number.isFinite(p.p95TtmsMs) ? Number(p.p95TtmsMs) : null
  );
  const errPct = points.map((p) =>
    Number.isFinite(p.errorRatePct) ? Number(p.errorRatePct) : null
  );
  const traffic = points.map((p) =>
    Number.isFinite(p.totalRequests) ? Number(p.totalRequests) : 0
  );

  // Only detect near "now" (end of window) for Phase 1.
  const lastIdx = points.length - 1;
  const lookback = Math.min(3, points.length); // check last up to 3 buckets
  const baselineWindow = Math.min(24, Math.max(6, points.length - lookback)); // try up to 2h baseline
  const minReqPerBucket = 100;

  // Build row bucket index for blast radius
  const { idx: bucketIndex } = buildBucketIndex(filteredRows || [], bucketSeconds);

  const signals = [];

  function makeTimeObj(bucketMsList) {
    if (!bucketMsList.length) {
      return { startTs: points[lastIdx].ts, endTs: points[lastIdx].ts, buckets: 1 };
    }
    const s = Math.min(...bucketMsList);
    const e = Math.max(...bucketMsList);
    return {
      startTs: new Date(s).toISOString(),
      endTs: new Date(e).toISOString(),
      buckets: bucketMsList.length,
    };
  }

  // Helper to convert indices -> bucketMs list
  function indicesToBucketMs(indices) {
    const out = [];
    for (const i of indices) {
      const ms = tsMs[i];
      if (Number.isFinite(ms)) out.push(ms);
    }
    return out;
  }

  // -----------------------------
  // Signal 1: Latency p95 spike
  // -----------------------------
  {
    const flags = new Array(points.length).fill(false);
    const ratios = new Array(points.length).fill(null);
    const baselines = new Array(points.length).fill(null);
    const mads = new Array(points.length).fill(null);

    for (let i = 0; i < points.length; i++) {
      const cur = p95[i];
      const req = traffic[i] || 0;
      if (!Number.isFinite(cur) || req < minReqPerBucket) continue;

      const { baseline, mad: m, n } = rollingBaseline(p95, i, baselineWindow);
      if (!Number.isFinite(baseline) || baseline <= 0 || n < 3) continue;

      const ratio = cur / baseline;
      ratios[i] = ratio;
      baselines[i] = baseline;
      mads[i] = m;

      // gate with ratio threshold
      if (ratio >= 1.6) flags[i] = true;
    }

    // Check most recent sustained buckets
    const recentIdx = [];
    for (let i = Math.max(0, lastIdx - (lookback - 1)); i <= lastIdx; i++)
      recentIdx.push(i);

    const recentTrues = recentIdx.filter((i) => flags[i]);
    const consec = consecutiveTrue(flags, lastIdx, lookback);

    if (recentTrues.length > 0) {
      const focusIdx =
        consec >= 2
          ? recentTrues.slice(-consec)
          : [recentTrues[recentTrues.length - 1]];
      const bucketMsList = indicesToBucketMs(focusIdx);

      const i = focusIdx[focusIdx.length - 1];
      const cur = p95[i];
      const base = baselines[i];
      const ratio = ratios[i] ?? (base ? cur / base : null);

      const br = blastRadiusForBuckets(bucketIndex, bucketMsList, totalRows);

      const strengthScore = clamp01((Number(ratio) - 1) / 2); // ratio 3 => 1
      const durationScore = clamp01((focusIdx.length - 1) / 2); // 1 bucket => 0, 3 buckets => 1
      const impactScore = clamp01(br.trafficShare / 0.25); // 25% => 1

      const confidence = computeConfidence({
        strengthScore,
        durationScore,
        impactScore,
        dataQualityScore: dqScore,
      });

      const severity = severityFrom({
        kind: "latency",
        ratio: Number(ratio) || 1,
        currentAbs: Number(cur) || 0,
        trafficShare: br.trafficShare,
      });

      const z =
        Number.isFinite(mads[i]) && mads[i] > 0
          ? (cur - base) / (1.4826 * mads[i])
          : null;

      const durationStr = fmtDurationBuckets(focusIdx.length, bucketSeconds);

      signals.push({
        id: "latency_p95_spike",
        severity,
        confidence,
        scope: { service: scope?.service, region: scope?.region, pop: scope?.pop },
        time: makeTimeObj(bucketMsList),
        baseline: { method: "rolling_median_mad", windowBuckets: baselineWindow, value: base },
        current: { value: cur, ratio: Number(ratio), z: Number.isFinite(z) ? Number(z) : null },
        blastRadius: {
          trafficShare: br.trafficShare,
          affectedPops: br.affectedPops,
          affectedHosts: br.affectedHosts,
          concentrationTop3Pops: br.concentrationTop3Pops,
        },
        // ✅ friendly + SRE detail
        explanation:
          `Latency spike: P95 is ${Number(ratio).toFixed(2)}× baseline ` +
          `(${formatMs(base)} → ${formatMs(cur)}), lasting ~${durationStr}. ` +
          `Blast radius ${fmtShare(br.trafficShare)} of scoped traffic (${br.affectedPops} pops, ${br.affectedHosts} hosts).`,
      });
    }
  }

  // -----------------------------
  // Signal 2: Error rate spike (5xx)
  // -----------------------------
  {
    const flags = new Array(points.length).fill(false);
    const ratios = new Array(points.length).fill(null);
    const baselines = new Array(points.length).fill(null);

    for (let i = 0; i < points.length; i++) {
      const cur = errPct[i];
      const req = traffic[i] || 0;
      if (!Number.isFinite(cur) || req < minReqPerBucket) continue;

      const { baseline, n } = rollingBaseline(errPct, i, baselineWindow);
      if (!Number.isFinite(baseline) || n < 3) continue;

      const ratio = (cur + 0.1) / (baseline + 0.1);
      ratios[i] = ratio;
      baselines[i] = baseline;

      // gate: either ratio jump OR absolute jump
      if (ratio >= 2.0 || cur >= baseline + 2.0) flags[i] = true;
    }

    const recentIdx = [];
    for (let i = Math.max(0, lastIdx - (lookback - 1)); i <= lastIdx; i++)
      recentIdx.push(i);
    const recentTrues = recentIdx.filter((i) => flags[i]);
    const consec = consecutiveTrue(flags, lastIdx, lookback);

    if (recentTrues.length > 0) {
      const focusIdx =
        consec >= 2
          ? recentTrues.slice(-consec)
          : [recentTrues[recentTrues.length - 1]];
      const bucketMsList = indicesToBucketMs(focusIdx);

      const i = focusIdx[focusIdx.length - 1];
      const cur = errPct[i];
      const base = baselines[i];
      const ratio = ratios[i] ?? (base != null ? (cur + 0.1) / (base + 0.1) : 1);

      const br = blastRadiusForBuckets(bucketIndex, bucketMsList, totalRows);

      const strengthScore = clamp01((Number(ratio) - 1) / 3); // ratio 4 => 1
      const durationScore = clamp01((focusIdx.length - 1) / 2);
      const impactScore = clamp01(br.trafficShare / 0.25);

      const confidence = computeConfidence({
        strengthScore,
        durationScore,
        impactScore,
        dataQualityScore: dqScore,
      });

      const severity = severityFrom({
        kind: "error",
        ratio: Number(ratio) || 1,
        currentAbs: Number(cur) || 0,
        trafficShare: br.trafficShare,
      });

      const durationStr = fmtDurationBuckets(focusIdx.length, bucketSeconds);

      signals.push({
        id: "error_rate_spike_5xx",
        severity,
        confidence,
        scope: { service: scope?.service, region: scope?.region, pop: scope?.pop },
        time: makeTimeObj(bucketMsList),
        baseline: { method: "rolling_median_mad", windowBuckets: baselineWindow, value: base },
        current: { value: cur, ratio: Number(ratio), z: null },
        blastRadius: {
          trafficShare: br.trafficShare,
          affectedPops: br.affectedPops,
          affectedHosts: br.affectedHosts,
          concentrationTop3Pops: br.concentrationTop3Pops,
        },
        explanation:
          `Error spike: 5xx rate increased from ${formatPct(base)} → ${formatPct(cur)} ` +
          `(${Number(ratio).toFixed(2)}×), lasting ~${durationStr}. ` +
          `Blast radius ${fmtShare(br.trafficShare)} of scoped traffic.`,
      });
    }
  }

  // -----------------------------
  // Signal 3: Traffic drop
  // -----------------------------
  {
    const flags = new Array(points.length).fill(false);
    const ratios = new Array(points.length).fill(null);
    const baselines = new Array(points.length).fill(null);

    for (let i = 0; i < points.length; i++) {
      const cur = traffic[i] || 0;

      const { baseline, n } = rollingBaseline(traffic, i, baselineWindow);
      if (!Number.isFinite(baseline) || baseline <= 0 || n < 3) continue;

      baselines[i] = baseline;

      // drop ratio defined as baseline / current
      const ratio = baseline / Math.max(1, cur);
      ratios[i] = ratio;

      if (cur <= baseline * 0.6) flags[i] = true;
    }

    const recentIdx = [];
    for (let i = Math.max(0, lastIdx - (lookback - 1)); i <= lastIdx; i++)
      recentIdx.push(i);
    const recentTrues = recentIdx.filter((i) => flags[i]);
    const consec = consecutiveTrue(flags, lastIdx, lookback);

    if (recentTrues.length > 0) {
      const focusIdx =
        consec >= 2
          ? recentTrues.slice(-consec)
          : [recentTrues[recentTrues.length - 1]];
      const bucketMsList = indicesToBucketMs(focusIdx);

      const i = focusIdx[focusIdx.length - 1];
      const cur = traffic[i] || 0;
      const base = baselines[i];
      const ratio = ratios[i] ?? (base ? base / Math.max(1, cur) : 1);

      const br = blastRadiusForBuckets(bucketIndex, bucketMsList, totalRows);

      const strengthScore = clamp01((Number(ratio) - 1) / 2); // baseline 3x current => 1
      const durationScore = clamp01((focusIdx.length - 1) / 2);
      const impactScore = clamp01(br.trafficShare / 0.25);

      const confidence = computeConfidence({
        strengthScore,
        durationScore,
        impactScore,
        dataQualityScore: dqScore,
      });

      const severity = severityFrom({
        kind: "traffic",
        ratio: Number(ratio) || 1,
        currentAbs: Number(cur) || 0,
        trafficShare: br.trafficShare,
      });

      const dropPct = base && base > 0 ? (1 - cur / base) * 100 : null;
      const durationStr = fmtDurationBuckets(focusIdx.length, bucketSeconds);

      signals.push({
        id: "traffic_drop",
        severity,
        confidence,
        scope: { service: scope?.service, region: scope?.region, pop: scope?.pop },
        time: makeTimeObj(bucketMsList),
        baseline: { method: "rolling_median_mad", windowBuckets: baselineWindow, value: base },
        current: { value: cur, ratio: Number(ratio), z: null },
        blastRadius: {
          trafficShare: br.trafficShare,
          affectedPops: br.affectedPops,
          affectedHosts: br.affectedHosts,
          concentrationTop3Pops: br.concentrationTop3Pops,
        },
        explanation:
          `Traffic dip: down ${dropPct != null ? dropPct.toFixed(0) : "?"}% vs baseline ` +
          `(${formatInt(base ?? 0)} → ${formatInt(cur)} req/5m), lasting ~${durationStr}. ` +
          `Blast radius ${fmtShare(br.trafficShare)} of scoped traffic.`,
      });
    }
  }

  // Overall blast radius = union of all signal buckets (best-effort)
  const unionBucketMs = new Set();
  for (const s of signals) {
    const start = Date.parse(s.time.startTs);
    const end = Date.parse(s.time.endTs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    // add buckets between start..end at bucketSeconds granularity
    const step = bucketSeconds * 1000;
    for (let t = start; t <= end; t += step) unionBucketMs.add(t);
  }
  const overallBR = blastRadiusForBuckets(bucketIndex, [...unionBucketMs], totalRows);

  // Overall confidence = max signal confidence
  const overallConfidence = signals.reduce(
    (m, s) => Math.max(m, Number(s.confidence) || 0),
    0
  );

  // Health classification
  const hasIncidentSignal = signals.some(
    (s) =>
      (s.severity === "high" || s.severity === "critical") &&
      (Number(s.confidence) || 0) >= 0.7 &&
      (Number(s.blastRadius?.trafficShare) || 0) >= 0.1
  );

  const hasWatchSignal = signals.some((s) => (Number(s.confidence) || 0) >= 0.5);

  const health = hasIncidentSignal ? "incident" : hasWatchSignal ? "watch" : "healthy";

  // Summary: pick strongest (severity + confidence)
  function sevRank(sev) {
    if (sev === "critical") return 4;
    if (sev === "high") return 3;
    if (sev === "medium") return 2;
    return 1;
  }
  const top = [...signals].sort((a, b) => {
    const r = sevRank(b.severity) - sevRank(a.severity);
    if (r !== 0) return r;
    return (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
  })[0];

  // ✅ user-friendly summary line with SRE signal
  const summary = top
    ? `${health.toUpperCase()}: ${top.explanation} ` +
      `(confidence ${fmtConfidence(top.confidence)}, window share ${fmtShare(
        top.blastRadius.trafficShare
      )}, ${top.time.buckets <= 1 ? "single-bucket" : "multi-bucket"}).`
    : "HEALTHY: No anomalies detected in the last few buckets.";

  return {
    health,
    overallConfidence: clamp01(overallConfidence),
    summary,
    signals,
    blastRadius: {
      trafficShare: overallBR.trafficShare,
      affectedPops: overallBR.affectedPops,
      affectedHosts: overallBR.affectedHosts,
      concentrationTop3Pops: overallBR.concentrationTop3Pops,
    },
  };
}

// ------------------------------------------------------------
// CSV parsing
// ------------------------------------------------------------
function parseCsv(csvText) {
  const text = String(csvText).trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, "").trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    const cols = splitCsvLine(line);
    const obj = {};

    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      let val = cols[c] ?? "";
      val = String(val).replace(/^"|"$/g, "");
      obj[key] = val;
    }

    const has = (k) =>
      obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "";

    // URL aliasing
    if (!has("url")) {
      if (has("uri")) obj.url = obj.uri;
      else if (has("request")) obj.url = obj.request;
      else if (has("req")) obj.url = obj.req;
      else if (has("path")) obj.url = obj.path;
    }

    // Host aliasing
    if (!has("host")) {
      if (has("hostname")) obj.host = obj.hostname;
      else if (has("edge")) obj.host = obj.edge;
      else if (has("edge_host")) obj.host = obj.edge_host;
      else if (has("edgeHost")) obj.host = obj.edgeHost;
    }

    // Status normalization
    if (!has("edge_status")) {
      if (has("status")) obj.edge_status = obj.status;
      else if (has("http_status")) obj.edge_status = obj.http_status;
      else if (has("response_code")) obj.edge_status = obj.response_code;
    }
    if (has("edge_status")) obj.edge_status = Number(obj.edge_status);

    // Mid status optional
    if (has("mid_status")) obj.mid_status = Number(obj.mid_status);

    // TTMS normalization
    if (!has("ttms_ms")) {
      if (has("ttms")) obj.ttms_ms = obj.ttms;
      else if (has("time_to_first_byte")) obj.ttms_ms = obj.time_to_first_byte;
      else if (has("ttfb_ms")) obj.ttms_ms = obj.ttfb_ms;
    }
    if (has("ttms_ms")) obj.ttms_ms = Number(obj.ttms_ms);

    // Bytes/cache hit optional
    if (has("upstream_bytes")) obj.upstream_bytes = Number(obj.upstream_bytes);
    if (has("edge_cache_hit")) obj.edge_cache_hit = Number(obj.edge_cache_hit);

    // Canonical dims
    obj.service = normLower(obj.delivery_service ?? obj.service) || "unknown";
    obj.crc = normUpper(obj.crc) || "UNKNOWN";
    obj.crc_class = deriveCrcClass(obj.crc);

    // Host/URL parsing strategy
    const hpHost = deriveHostSvcRegionPopFromUrl(obj.host || obj.hostname || "");
    const hpUrl = deriveHostSvcRegionPopFromUrl(obj.url || "");

    obj.svc = normLower(obj.svc ?? hpUrl.svc ?? hpHost.svc) || "unknown";
    obj.edge_host = normLower(obj.edge_host ?? hpHost.edge_host ?? hpUrl.edge_host) || "unknown";
    obj.region = normLower(obj.region ?? hpHost.region ?? hpUrl.region) || "unknown";
    obj.pop = normLower(obj.pop ?? hpHost.pop ?? hpUrl.pop) || "unknown";

    // stable "service bucket" used for UI filter live/vod/all
    obj.service_bucket = deriveServiceBucket(obj);

    rows.push(obj);
  }

  return rows;
}

// ------------------------------------------------------------
// Debug helpers (kept as-is)
// ------------------------------------------------------------
function buildDebugObj({ rows, inWindow, filtered, startISO, endISO, anchorISO, dq, warnings }) {
  const sample = filtered[0] ?? inWindow[0] ?? null;
  const sampleCompact = sample
    ? {
        ts: sample.ts,
        service: sample.service,
        service_bucket: sample.service_bucket,
        svc: sample.svc,
        edge_host: sample.edge_host,
        region: sample.region,
        pop: sample.pop,
        crc: sample.crc,
        crc_class: sample.crc_class,
        edge_status: sample.edge_status,
        ttms_ms: sample.ttms_ms,
        url: sample.url,
        host: sample.host,
      }
    : null;

  return {
    rows_total: rows.length,
    rows_inWindow: inWindow.length,
    rows_filtered: filtered.length,
    time: { anchor: anchorISO, start: startISO, end: endISO },
    available: {
      service_bucket: topValuesPretty(inWindow, "service_bucket", 8),
      service: topValuesPretty(inWindow, "service", 8),
      svc: topValuesPretty(inWindow, "svc", 8),
      edge_host: topValuesPretty(inWindow, "edge_host", 8),
      region: topValuesPretty(inWindow, "region", 12),
      pop: topValuesPretty(inWindow, "pop", 12),
      crc_class: topValuesPretty(inWindow, "crc_class", 8),
      crc: topValuesPretty(inWindow, "crc", 8),
      edge_status: topValuesPretty(inWindow, "edge_status", 12),
    },
    data_quality: dq,
    warnings,
    sample: sampleCompact,
  };
}

function debugBlock(dbg) {
  const sample = dbg.sample ? JSON.stringify(dbg.sample) : "n/a";
  const w = dbg.warnings?.length ? dbg.warnings.join(" | ") : "none";
  const dq = dbg.data_quality ? JSON.stringify(dbg.data_quality) : "n/a";

  return [
    `--- DEBUG ---`,
    `rows_total=${dbg.rows_total}`,
    `rows_inWindow=${dbg.rows_inWindow}`,
    `rows_filtered=${dbg.rows_filtered}`,
    `anchor=${dbg.time.anchor}`,
    `start=${dbg.time.start}`,
    `end=${dbg.time.end}`,
    `avail_service_bucket=${dbg.available.service_bucket}`,
    `avail_service=${dbg.available.service}`,
    `avail_svc=${dbg.available.svc}`,
    `avail_edge_host=${dbg.available.edge_host}`,
    `avail_region=${dbg.available.region}`,
    `avail_pop=${dbg.available.pop}`,
    `avail_crc_class=${dbg.available.crc_class}`,
    `avail_crc=${dbg.available.crc}`,
    `avail_edge_status=${dbg.available.edge_status}`,
    `data_quality=${dq}`,
    `warnings=${w}`,
    `sample=${sample}`,
  ].join("\n");
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------
export function runTriage({
  csvText,
  service = "all",
  region = "all",
  pop = "all",
  windowMinutes = 60,
  filters = [],
  debug = false,
}) {
  let filtersArr = [];
  if (Array.isArray(filters)) filtersArr = filters;
  else if (typeof filters === "string" && filters.trim()) {
    try {
      filtersArr = JSON.parse(filters);
    } catch {
      filtersArr = [];
    }
  } else filtersArr = [];

  if (!csvText) throw new Error("No CSV text found.");

  const rows = parseCsv(csvText);
  if (rows.length === 0)
    throw new Error("Parsed 0 rows from CSV. Check delimiter/quotes/header line.");

  const dqAll = {
    invalid_ts: rows.filter((r) => !r.ts || Number.isNaN(toMs(r.ts))).length,
    missing_edge_status: rows.filter((r) => !Number.isFinite(r.edge_status)).length,
    unknown_service: rows.filter((r) => r.service === "unknown").length,
    unknown_crc: rows.filter((r) => r.crc === "UNKNOWN").length,
    unknown_region: rows.filter((r) => r.region === "unknown").length,
    unknown_pop: rows.filter((r) => r.pop === "unknown").length,
    unknown_svc: rows.filter((r) => r.svc === "unknown").length,
    unknown_edge_host: rows.filter((r) => r.edge_host === "unknown").length,
  };

  let anchor = null;
  let validTsCount = 0;
  for (const r of rows) {
    const ms = toMs(r.ts);
    if (!Number.isNaN(ms)) {
      validTsCount++;
      anchor = anchor == null ? ms : Math.max(anchor, ms);
    }
  }
  if (validTsCount === 0 || anchor == null) {
    throw new Error("No valid timestamps found. Check ts format (expected ISO-like).");
  }

  const start = anchor - Number(windowMinutes) * 60 * 1000;
  const end = anchor;

  const inWindow = rows.filter((r) => {
    const ms = toMs(r.ts);
    if (Number.isNaN(ms)) return false;
    return ms >= start && ms <= end;
  });

  const startISO = new Date(start).toISOString();
  const endISO = new Date(end).toISOString();
  const anchorISO = endISO;

  const dqWindow = {
    invalid_ts: inWindow.filter((r) => !r.ts || Number.isNaN(toMs(r.ts))).length,
    missing_edge_status: inWindow.filter((r) => !Number.isFinite(r.edge_status)).length,
    unknown_service: inWindow.filter((r) => r.service === "unknown").length,
    unknown_crc: inWindow.filter((r) => r.crc === "UNKNOWN").length,
    unknown_region: inWindow.filter((r) => r.region === "unknown").length,
    unknown_pop: inWindow.filter((r) => r.pop === "unknown").length,
    unknown_svc: inWindow.filter((r) => r.svc === "unknown").length,
    unknown_edge_host: inWindow.filter((r) => r.edge_host === "unknown").length,
  };

  const available = {
    regions: topKeys(inWindow, "region", 80),
    pops: topKeys(inWindow, "pop", 120),
    serviceBuckets: topKeys(inWindow, "service_bucket", 12),
    svcs: topKeys(inWindow, "svc", 24),
    edgeHosts: topKeys(inWindow, "edge_host", 24),
    crcClasses: topKeys(inWindow, "crc_class", 12),
    crcs: topKeys(inWindow, "crc", 24),
    statusCodes: topKeys(inWindow, "edge_status", 24),
  };

  const warnings = [];

  let filtered = inWindow;

  const beforeService = filtered.length;
  filtered = filtered.filter((r) => matchDim(r.service_bucket, service, "service_bucket"));
  if (service !== "all" && inWindow.length > 0 && filtered.length === beforeService) {
    warnings.push(
      `Service filter '${service}' did not reduce dataset (check service_bucket derivation).`
    );
  }

  const beforeRegion = filtered.length;
  filtered = filtered.filter((r) => matchDim(r.region, region, "region"));
  if (region !== "all" && inWindow.length > 0 && filtered.length === beforeRegion) {
    warnings.push(`Region filter '${region}' did not reduce dataset.`);
  }

  const beforePop = filtered.length;
  filtered = filtered.filter((r) => matchDim(r.pop, pop, "pop"));
  if (pop !== "all" && inWindow.length > 0 && filtered.length === beforePop) {
    warnings.push(`POP filter '${pop}' did not reduce dataset.`);
  }

  for (const f of filtersArr) {
    const beforeFilter = filtered.length;
    filtered = filtered.filter((r) => passesFilter(r, f));
    if (beforeFilter > 0 && filtered.length === 0) {
      warnings.push(`Additional filter removed all rows: ${JSON.stringify(f)}`);
    }
  }

  if (inWindow.length > 0 && filtered.length === 0) {
    warnings.push(`Filters removed all rows. Check available values (metricsJson.available).`);
  }
  if (dqWindow.missing_edge_status > 0)
    warnings.push(`Some rows missing edge_status (${dqWindow.missing_edge_status}).`);
  if (dqWindow.invalid_ts > 0)
    warnings.push(`Some rows have invalid ts in window (${dqWindow.invalid_ts}).`);

  const dbg = debug
    ? buildDebugObj({
        rows,
        inWindow,
        filtered,
        startISO,
        endISO,
        anchorISO,
        dq: { all: dqAll, window: dqWindow },
        warnings,
      })
    : null;

  // ----------------------------
  // Empty-window fast return
  // ----------------------------
  if (inWindow.length === 0) {
    const anomalies = computeAnomalies({
      timeseries: emptyTimeseries(),
      filteredRows: [],
      dqWindow,
      scope: { service, region, pop },
    });

    const summaryText = [
      `🧭 *CDN TRIAGE SUMMARY*`,
      `No data found in requested time window.`,
      `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``,
      `• Window: \`${windowMinutes}m\`  • Filters: \`${prettyFilters(filtersArr)}\``,
      `• Time (UTC): \`${startISO}\` → \`${endISO}\``,
      ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
      ...(debug && dbg ? ["", "```", debugBlock(dbg), "```"] : []),
    ].join("\n");

    return {
      summaryText,
      metricsJson: {
        available,
        timeRangeUTC: { start: startISO, end: endISO },
        totalRequests: 0,
        p95TtmsMs: null,
        p99TtmsMs: null,
        cacheHitPct: null,
        cacheMissPct: null,
        statusCounts: [],
        error5xxCount: 0,
        errorRatePct: null,
        timeseries: emptyTimeseries(),
        anomalies,
        warnings,
        dataQuality: { all: dqAll, window: dqWindow },
        debug: dbg,
      },
    };
  }

  // ----------------------------
  // No-match fast return
  // ----------------------------
  if (filtered.length === 0) {
    const anomalies = computeAnomalies({
      timeseries: emptyTimeseries(),
      filteredRows: [],
      dqWindow,
      scope: { service, region, pop },
    });

    const summaryText = [
      `🧭 *CDN TRIAGE SUMMARY*`,
      `No rows matched your filters.`,
      `• Requested: service=\`${service}\` region=\`${region}\` pop=\`${pop}\` window=\`${windowMinutes}m\``,
      `• Filters: \`${prettyFilters(filtersArr)}\``,
      `• Available (this window):`,
      `   - serviceBuckets: ${(available.serviceBuckets || []).join(", ") || "n/a"}`,
      `   - regions: ${(available.regions || []).slice(0, 20).join(", ") || "n/a"}${
        (available.regions || []).length > 20 ? " ..." : ""
      }`,
      `   - pops: ${(available.pops || []).slice(0, 20).join(", ") || "n/a"}${
        (available.pops || []).length > 20 ? " ..." : ""
      }`,
      ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
      ...(debug && dbg ? ["", "```", debugBlock(dbg), "```"] : []),
    ].join("\n");

    return {
      summaryText,
      metricsJson: {
        available,
        timeRangeUTC: { start: startISO, end: endISO },
        totalRequests: 0,
        p95TtmsMs: null,
        p99TtmsMs: null,
        cacheHitPct: null,
        cacheMissPct: null,
        statusCounts: [],
        error5xxCount: 0,
        errorRatePct: null,
        timeseries: emptyTimeseries(),
        anomalies,
        warnings,
        dataQuality: { all: dqAll, window: dqWindow },
        debug: dbg,
      },
    };
  }

  const total = filtered.length;

  // ✅ fixed 5m bucket timeseries + stacked series maps
  const timeseries = buildTimeseriesPoints(filtered);

  // ✅ Phase 1 anomalies (latency spike, error spike, traffic drop + blast radius + confidence)
  const anomalies = computeAnomalies({
    timeseries,
    filteredRows: filtered,
    dqWindow,
    scope: { service, region, pop },
  });

  const ttmsVals = filtered
    .map((r) => Number(r.ttms_ms))
    .filter((v) => Number.isFinite(v));
  const p95Val = percentile(ttmsVals, 95);
  const p99Val = percentile(ttmsVals, 99);

  const hitCount = filtered.filter((r) => Number(r.edge_cache_hit) === 1).length;
  const hitRatio = total ? (hitCount / total) * 100 : null;

  const missCount = filtered.filter((r) => Number(r.edge_cache_hit) === 0).length;
  const missRatio = total ? (missCount / total) * 100 : null;

  const statusCountsPairs = countBy(filtered, "edge_status");

  const errorRows = filtered.filter((r) => Number(r.edge_status) >= 500);
  const errorCount = errorRows.length;
  const errorRate = total ? (errorCount / total) * 100 : null;

  const topCrcClass = topCounts(filtered, "crc_class", 4);
  const topErrorsByCrc = topCounts(errorRows, "crc", 4);

  const evidence = [];
  if (errorCount > 0) {
    const topErr = topErrorsByCrc[0];
    if (topErr)
      evidence.push(
        `Error responses are dominated by \`${topErr[0]}\` (${topErr[1]} of ${errorCount}).`
      );
    evidence.push(`Error responses: ${errorCount}/${total} (${formatPct(errorRate)}).`);
  } else {
    evidence.push(`No 5xx responses observed.`);
  }
  evidence.push(`Cache hit ratio ${formatPct(hitRatio)} (miss ${formatPct(missRatio)}).`);
  evidence.push(`Latency p95/p99 TTMS = ${formatMs(p95Val)}/${formatMs(p99Val)}.`);

  // Optional: include anomalies in summary text (nice UX)
  const anomalyLines = [];
  if (anomalies?.signals?.length) {
    anomalyLines.push(`🚨 *Anomalies*`);
    anomalyLines.push(
      `• Health: *${String(anomalies.health).toUpperCase()}* (confidence ${Math.round(
        anomalies.overallConfidence * 100
      )}%)`
    );
    anomalyLines.push(`• ${anomalies.summary}`);
  }

  const header = `🧭 *CDN TRIAGE SUMMARY*`;
  const scopeLine = `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``;
  const windowLine = `• Window: \`${windowMinutes}m\`  • Time (UTC): \`${startISO}\` → \`${endISO}\``;
  const filterLine = `• Filters: \`${prettyFilters(filtersArr)}\``;

  const trafficPerf = [
    `📊 *Traffic & Performance*`,
    `• Requests: *${formatInt(total)}*`,
    `• P95 TTMS: *${formatMs(p95Val)}*`,
    `• P99 TTMS: *${formatMs(p99Val)}*`,
    `• Cache Hit: *${formatPct(hitRatio)}*  (miss ${formatPct(missRatio)})`,
  ].join("\n");

  const statusBlock = [`🧮 *Response Codes*`, prettyStatusCounts(statusCountsPairs, 12)].join("\n");

  const breakdown = [
    `🧩 *Top breakdowns*`,
    `• service_bucket: ${topValuesPretty(filtered, "service_bucket", 4)}`,
    `• svc: ${topValuesPretty(filtered, "svc", 4)}`,
    `• edge_host: ${topValuesPretty(filtered, "edge_host", 4)}`,
    `• region: ${topValuesPretty(filtered, "region", 6)}`,
    `• pop: ${topValuesPretty(filtered, "pop", 6)}`,
    `• crc_class: ${
      topCrcClass.length ? topCrcClass.map(([v, c]) => `${v} (${c})`).join(", ") : "n/a"
    }`,
  ].join("\n");

  const evidenceBlock = [`🧾 *Evidence*`, ...evidence.map((x) => `• ${x}`)].join("\n");

  const dqLines = [];
  if (
    dqWindow.missing_edge_status ||
    dqWindow.unknown_service ||
    dqWindow.unknown_crc ||
    dqWindow.unknown_region ||
    dqWindow.unknown_pop ||
    dqWindow.unknown_svc ||
    dqWindow.unknown_edge_host
  ) {
    dqLines.push(`⚠️ *Data Quality (window)*`);
    if (dqWindow.missing_edge_status)
      dqLines.push(`• missing edge_status: ${dqWindow.missing_edge_status}`);
    if (dqWindow.unknown_service) dqLines.push(`• unknown service: ${dqWindow.unknown_service}`);
    if (dqWindow.unknown_svc) dqLines.push(`• unknown svc: ${dqWindow.unknown_svc}`);
    if (dqWindow.unknown_edge_host) dqLines.push(`• unknown edge_host: ${dqWindow.unknown_edge_host}`);
    if (dqWindow.unknown_crc) dqLines.push(`• unknown crc: ${dqWindow.unknown_crc}`);
    if (dqWindow.unknown_region) dqLines.push(`• unknown region: ${dqWindow.unknown_region}`);
    if (dqWindow.unknown_pop) dqLines.push(`• unknown pop: ${dqWindow.unknown_pop}`);
  }

  const warnLines = warnings.length ? [`⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : [];
  const debugSection = debug && dbg ? ["", "```", debugBlock(dbg), "```"].join("\n") : "";

  const summaryText = [
    header,
    scopeLine,
    windowLine,
    filterLine,
    ...(warnLines.length ? ["", ...warnLines] : []),
    ...(dqLines.length ? ["", ...dqLines] : []),
    ...(anomalyLines.length ? ["", ...anomalyLines] : []),
    "",
    trafficPerf,
    "",
    statusBlock,
    "",
    breakdown,
    "",
    evidenceBlock,
    debugSection,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    summaryText,
    metricsJson: {
      available,
      timeRangeUTC: { start: startISO, end: endISO },
      totalRequests: total,
      p95TtmsMs: p95Val,
      p99TtmsMs: p99Val,
      cacheHitPct: hitRatio,
      cacheMissPct: missRatio,
      statusCounts: statusCountsPairs.map(([code, count]) => ({ code: Number(code), count })),
      error5xxCount: errorCount,
      errorRatePct: errorRate,
      topCrcClass: topCrcClass.map(([k, v]) => ({ crc_class: k, count: v })),
      topErrorCrc: topErrorsByCrc.map(([k, v]) => ({ crc: k, count: v })),

      // ✅ includes status/host/crc series + per-bucket maps
      timeseries,

      // ✅ NEW: anomalies + confidence + blast radius
      anomalies,

      warnings,
      dataQuality: { all: dqAll, window: dqWindow },
      debug: dbg,
    },
  };
}
