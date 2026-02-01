// lib/triage/metricsEngine.js
// Ported from n8n Function node to a plain JS module.
// Returns { summaryText, metricsJson }.

// ✅ tiny export to help debug “module has no exports” build errors
export const __exportsCheck = true;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function normLower(v) { return String(v ?? "").trim().toLowerCase(); }
function normUpper(v) { return String(v ?? "").trim().toUpperCase(); }

function matchDim(value, expected) {
  if (!expected || expected === "all") return true;
  return normLower(value) === normLower(expected);
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const cleaned = arr.map(Number).filter((x) => Number.isFinite(x));
  if (cleaned.length === 0) return null;

  const sorted = [...cleaned].sort((a, b) => a - b);
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
      if (f?.type === "in") return `${f.key} in (${(f.values ?? []).join(",")})`;
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
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function topValuesPretty(rows, key, limit = 6) {
  const entries = topCounts(rows, key, limit);
  if (!entries.length) return "n/a";
  return entries.map(([v, c]) => `${v} (${c})`).join(", ");
}

function deriveRegionPopFromUrl(u) {
  const s = String(u || "");
  const m = s.match(/:\/\/edge-([a-z0-9]+)-([a-z0-9]+)\b/i);
  if (!m) return { region: null, pop: null };
  return { region: m[1].toLowerCase(), pop: m[2].toLowerCase() };
}

// ✅ NEW: host extraction (uses URL() when possible; regex fallback otherwise)
function deriveHostFromUrl(u) {
  const s = String(u ?? "").trim();
  if (!s) return null;

  try {
    const host = new URL(s).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    const m = s.match(/^https?:\/\/([^/]+)/i);
    return m?.[1]?.toLowerCase() ?? null;
  }
}

// ✅ NEW: tiny map helpers for breakdowns
function incMap(map, key, by = 1) {
  const k = String(key ?? "").trim();
  if (!k) return;
  map.set(k, (map.get(k) ?? 0) + by);
}

function mapToTopObject(map, limit = 12) {
  const out = Object.create(null);
  const arr = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [k, v] of arr) out[k] = v;
  return out;
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

  if (["TCP_HIT", "TCP_CF_HIT", "TCP_REF_FAIL_HIT", "TCP_REFRESH_HIT"].includes(c)) return "hit";
  if (["TCP_MISS", "TCP_REFRESH_MISS"].includes(c)) return "miss";
  if (["TCP_CLIENT_REFRESH"].includes(c)) return "client";

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
function chooseBucketSeconds(spanMinutes) {
  // 1m buckets for up to 3h spans; else 15m
  return Number(spanMinutes) <= 180 ? 60 : 900;
}

function percentileSorted(sortedArr, p) {
  // p is 0..1
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

function computeSpanMinutes(rows) {
  let minMs = null;
  let maxMs = null;

  for (const r of rows) {
    const t = toMs(r.ts);
    if (Number.isNaN(t)) continue;
    if (minMs == null || t < minMs) minMs = t;
    if (maxMs == null || t > maxMs) maxMs = t;
  }

  if (minMs == null || maxMs == null) return 0;
  return Math.max(0, (maxMs - minMs) / (60 * 1000));
}

/**
 * Timeseries point output:
 * {
 *   ts,
 *   totalRequests,
 *   error5xxCount,
 *   errorRatePct,
 *   p95TtmsMs,
 *   p99TtmsMs,
 *   statusCounts: { "200": 190, "302": 8, "500": 6, ... },
 *   crcCounts:    { "TCP_HIT": 120, "TCP_MISS": 30, "ERR_TIMEOUT": 5, ... },
 *   hostCounts:   { "edge.foo.com": 90, "api.bar.com": 20, ... }
 * }
 */
function buildTimeseriesPoints(rows, spanMinutes) {
  const bucketSeconds = chooseBucketSeconds(spanMinutes);
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
        statusCounts: Object.create(null),

        // ✅ NEW
        crcCounts: Object.create(null),
        hostCounts: Object.create(null),
      };
      buckets.set(b, acc);
    }

    acc.total += 1;

    // statusCounts + 5xx
    const edgeStatus = Number(r.edge_status);
    if (Number.isFinite(edgeStatus) && edgeStatus >= 100 && edgeStatus <= 599) {
      const k = String(edgeStatus);
      acc.statusCounts[k] = (acc.statusCounts[k] || 0) + 1;

      if (edgeStatus >= 500 && edgeStatus < 600) {
        acc.err5xx += 1;
      }
    }

    // ttms
    const ttms = Number(r.ttms_ms);
    if (Number.isFinite(ttms)) acc.ttms.push(ttms);

    // ✅ crcCounts
    const crc = String(r.crc ?? "").trim();
    if (crc) {
      acc.crcCounts[crc] = (acc.crcCounts[crc] || 0) + 1;
    }

    // ✅ hostCounts (prefer r.host computed in parseCsv)
    const host = String(r.host ?? deriveHostFromUrl(r.url) ?? "").trim().toLowerCase();
    if (host) {
      acc.hostCounts[host] = (acc.hostCounts[host] || 0) + 1;
    }
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);

  const points = keys.map((k) => {
    const acc = buckets.get(k) || {
      total: 0,
      err5xx: 0,
      ttms: [],
      statusCounts: Object.create(null),
      crcCounts: Object.create(null),
      hostCounts: Object.create(null),
    };

    const ttmsSorted = (acc.ttms || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);

    const p95 = percentileSorted(ttmsSorted, 0.95);
    const p99 = percentileSorted(ttmsSorted, 0.99);

    const errorRatePct = acc.total ? (acc.err5xx / acc.total) * 100 : 0;

    return {
      ts: new Date(k).toISOString(),
      totalRequests: acc.total,
      error5xxCount: acc.err5xx,
      errorRatePct: Number.isFinite(errorRatePct) ? errorRatePct : 0,
      p95TtmsMs: p95,
      p99TtmsMs: p99,

      statusCounts: acc.statusCounts || Object.create(null),
      crcCounts: acc.crcCounts || Object.create(null),
      hostCounts: acc.hostCounts || Object.create(null),
    };
  });

  const startTs =
    minMs == null ? null : new Date(Math.floor(minMs / bucketMs) * bucketMs).toISOString();
  const endTs =
    maxMs == null ? null : new Date(Math.floor(maxMs / bucketMs) * bucketMs).toISOString();

  return { bucketSeconds, startTs, endTs, points };
}

function emptyTimeseries() {
  return { bucketSeconds: null, startTs: null, endTs: null, points: [] };
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

    const has = (k) => obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "";

    // Status
    if (!has("edge_status")) {
      if (has("status")) obj.edge_status = obj.status;
      else if (has("http_status")) obj.edge_status = obj.http_status;
      else if (has("response_code")) obj.edge_status = obj.response_code;
    }
    if (has("edge_status")) {
      const n = Number(obj.edge_status);
      obj.edge_status = Number.isFinite(n) ? n : NaN;
    }

    // Mid status
    if (has("mid_status")) {
      const n = Number(obj.mid_status);
      obj.mid_status = Number.isFinite(n) ? n : NaN;
    }

    // TTMS
    if (!has("ttms_ms")) {
      if (has("ttms")) obj.ttms_ms = obj.ttms;
      else if (has("time_to_first_byte")) obj.ttms_ms = obj.time_to_first_byte;
    }
    if (has("ttms_ms")) {
      const n = Number(obj.ttms_ms);
      obj.ttms_ms = Number.isFinite(n) ? n : NaN;
    }

    // Bytes + cache hit
    if (has("upstream_bytes")) {
      const n = Number(obj.upstream_bytes);
      obj.upstream_bytes = Number.isFinite(n) ? n : NaN;
    }
    if (has("edge_cache_hit")) {
      const n = Number(obj.edge_cache_hit);
      obj.edge_cache_hit = Number.isFinite(n) ? n : NaN;
    }

    // Canonical dims
    obj.service = normLower(obj.delivery_service ?? obj.service) || "unknown";
    obj.crc = normUpper(obj.crc) || "UNKNOWN";
    obj.crc_class = deriveCrcClass(obj.crc);

    const rp = deriveRegionPopFromUrl(obj.url);
    obj.region = normLower(obj.region ?? rp.region) || "unknown";
    obj.pop = normLower(obj.pop ?? rp.pop) || "unknown";

    // ✅ host (store once; used by timeseries + hostBreakdown)
    // If your CSV already has host/req_host/hostname, prefer it; otherwise derive from url.
    if (!has("host")) {
      if (has("req_host")) obj.host = obj.req_host;
      else if (has("hostname")) obj.host = obj.hostname;
      else obj.host = deriveHostFromUrl(obj.url) || "unknown";
    }
    obj.host = normLower(obj.host) || "unknown";

    rows.push(obj);
  }

  return rows;
}

// ------------------------------------------------------------
// Debug helpers (unchanged)
// ------------------------------------------------------------
function buildDebugObj({ rows, inWindow, filtered, startISO, endISO, anchorISO, dq, warnings }) {
  const sample = filtered[0] ?? inWindow[0] ?? null;
  const sampleCompact = sample
    ? {
        ts: sample.ts,
        service: sample.service,
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
      service: topValuesPretty(inWindow, "service", 8),
      region: topValuesPretty(inWindow, "region", 8),
      pop: topValuesPretty(inWindow, "pop", 8),
      host: topValuesPretty(inWindow, "host", 8),
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
    `avail_service=${dbg.available.service}`,
    `avail_region=${dbg.available.region}`,
    `avail_pop=${dbg.available.pop}`,
    `avail_host=${dbg.available.host}`,
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
  // Accept filters as JSON string or object, but normalize to array
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
  if (rows.length === 0) {
    throw new Error("Parsed 0 rows from CSV. Check delimiter/quotes/header line.");
  }

  // Data quality counters (whole dataset)
  const dqAll = {
    invalid_ts: rows.filter((r) => !r.ts || Number.isNaN(toMs(r.ts))).length,
    missing_edge_status: rows.filter((r) => !Number.isFinite(Number(r.edge_status))).length,
    unknown_service: rows.filter((r) => r.service === "unknown").length,
    unknown_crc: rows.filter((r) => r.crc === "UNKNOWN").length,
    unknown_region: rows.filter((r) => r.region === "unknown").length,
    unknown_pop: rows.filter((r) => r.pop === "unknown").length,
    unknown_host: rows.filter((r) => r.host === "unknown").length,
  };

  // Anchor on MAX timestamp and compute window
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

  const windowM = Number(windowMinutes);
  if (!Number.isFinite(windowM) || windowM <= 0) {
    throw new Error("windowMinutes must be a positive number.");
  }

  const start = anchor - windowM * 60 * 1000;
  const end = anchor;

  const inWindow = rows.filter((r) => {
    const ms = toMs(r.ts);
    if (Number.isNaN(ms)) return false;
    return ms >= start && ms <= end;
  });

  const startISO = new Date(start).toISOString();
  const endISO = new Date(end).toISOString();
  const anchorISO = endISO;

  // Data quality counters (window)
  const dqWindow = {
    invalid_ts: inWindow.filter((r) => !r.ts || Number.isNaN(toMs(r.ts))).length,
    missing_edge_status: inWindow.filter((r) => !Number.isFinite(Number(r.edge_status))).length,
    unknown_service: inWindow.filter((r) => r.service === "unknown").length,
    unknown_crc: inWindow.filter((r) => r.crc === "UNKNOWN").length,
    unknown_region: inWindow.filter((r) => r.region === "unknown").length,
    unknown_pop: inWindow.filter((r) => r.pop === "unknown").length,
    unknown_host: inWindow.filter((r) => r.host === "unknown").length,
  };

  // Apply filters + dimensions
  let filtered = inWindow
    .filter((r) => matchDim(r.service, service))
    .filter((r) => matchDim(r.region, region))
    .filter((r) => matchDim(r.pop, pop));

  for (const f of filtersArr) {
    filtered = filtered.filter((r) => passesFilter(r, f));
  }

  // Warnings
  const warnings = [];
  if (service !== "all" && filtered.length === inWindow.length && inWindow.length > 0) {
    warnings.push(`Service filter '${service}' did not reduce dataset (possible schema mismatch).`);
  }
  if (region !== "all" && filtered.length === inWindow.length && inWindow.length > 0) {
    warnings.push(`Region filter '${region}' did not reduce dataset.`);
  }
  if (pop !== "all" && filtered.length === inWindow.length && inWindow.length > 0) {
    warnings.push(`POP filter '${pop}' did not reduce dataset.`);
  }
  if (inWindow.length > 0 && filtered.length === 0) {
    warnings.push(`Filters removed all rows. Check available values in DEBUG.`);
  }
  if (dqWindow.missing_edge_status > 0) {
    warnings.push(
      `Some rows missing edge_status (${dqWindow.missing_edge_status}). Response code totals may not sum perfectly.`
    );
  }
  if (dqWindow.invalid_ts > 0) {
    warnings.push(`Some rows have invalid ts in window (${dqWindow.invalid_ts}).`);
  }

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

  // Empty window
  if (inWindow.length === 0) {
    const summaryText = [
      `🧭 *CDN TRIAGE SUMMARY*`,
      `No data found in requested time window.`,
      `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``,
      `• Window: \`${windowM}m\`  • Filters: \`${prettyFilters(filtersArr)}\``,
      `• Time (UTC): \`${startISO}\` → \`${endISO}\``,
      ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
      ...(debug && dbg ? ["", "```", debugBlock(dbg), "```"] : []),
    ].join("\n");

    return {
      summaryText,
      metricsJson: {
        timeRangeUTC: { start: startISO, end: endISO },
        totalRequests: 0,
        p95TtmsMs: null,
        p99TtmsMs: null,
        cacheHitPct: null,
        cacheMissPct: null,
        statusCounts: [],
        timeseries: emptyTimeseries(),
        hostBreakdown: [],
        crcByHost: [],
        warnings,
        dataQuality: { all: dqAll, window: dqWindow },
        debug: dbg,
      },
    };
  }

  // No matches after filters
  if (filtered.length === 0) {
    const summaryText = [
      `🧭 *CDN TRIAGE SUMMARY*`,
      `No rows matched your filters.`,
      `• Requested: service=\`${service}\` region=\`${region}\` pop=\`${pop}\` window=\`${windowM}m\``,
      `• Filters: \`${prettyFilters(filtersArr)}\``,
      `• Available (this window):`,
      `   - service: ${topValuesPretty(inWindow, "service")}`,
      `   - region: ${topValuesPretty(inWindow, "region")}`,
      `   - pop: ${topValuesPretty(inWindow, "pop")}`,
      `   - host: ${topValuesPretty(inWindow, "host")}`,
      `   - crc_class: ${topValuesPretty(inWindow, "crc_class")}`,
      `   - edge_status: ${topValuesPretty(inWindow, "edge_status")}`,
      ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map((w) => `• ${w}`)] : []),
      ...(debug && dbg ? ["", "```", debugBlock(dbg), "```"] : []),
    ].join("\n");

    return {
      summaryText,
      metricsJson: {
        timeRangeUTC: { start: startISO, end: endISO },
        totalRequests: 0,
        p95TtmsMs: null,
        p99TtmsMs: null,
        cacheHitPct: null,
        cacheMissPct: null,
        statusCounts: [],
        timeseries: emptyTimeseries(),
        hostBreakdown: [],
        crcByHost: [],
        warnings,
        dataQuality: { all: dqAll, window: dqWindow },
        debug: dbg,
      },
    };
  }

  // ------------------------------------------------------------
  // Metrics (window-level)
  // ------------------------------------------------------------
  const total = filtered.length;

  // ✅ Bucket choice based on ACTUAL span, not user input
  const spanMinutes = Math.max(1, computeSpanMinutes(filtered));
  const timeseries = buildTimeseriesPoints(filtered, spanMinutes);

  const ttmsVals = filtered.map((r) => Number(r.ttms_ms)).filter((v) => Number.isFinite(v));
  const p95 = percentile(ttmsVals, 95);
  const p99 = percentile(ttmsVals, 99);

  const hitCount = filtered.filter((r) => Number(r.edge_cache_hit) === 1).length;
  const hitRatio = total ? (hitCount / total) * 100 : null;

  const missCount = filtered.filter((r) => Number(r.edge_cache_hit) === 0).length;
  const missRatio = total ? (missCount / total) * 100 : null;

  const statusCountsPairs = countBy(filtered, "edge_status");

  const errorRows = filtered.filter((r) => {
    const s = Number(r.edge_status);
    return Number.isFinite(s) && s >= 500;
  });
  const errorCount = errorRows.length;
  const errorRate = total ? (errorCount / total) * 100 : null;

  const topCrcClass = topCounts(filtered, "crc_class", 4);
  const topErrorsByCrc = topCounts(errorRows, "crc", 4);

  // ------------------------------------------------------------
  // ✅ NEW: Host breakdown (p95/p99 by host + crcCounts per host + statusCounts per host)
  // ------------------------------------------------------------
  const HOST_LIMIT = 12;
  const CRC_PER_HOST_LIMIT = 12;
  const STATUS_PER_HOST_LIMIT = 12;

  const hostAgg = new Map(); // host -> { total, ttms: [], crcCounts: Map, statusCounts: Map }

  for (const r of filtered) {
    const host = String(r.host ?? "unknown").trim().toLowerCase() || "unknown";
    let acc = hostAgg.get(host);
    if (!acc) {
      acc = { total: 0, ttms: [], crcCounts: new Map(), statusCounts: new Map() };
      hostAgg.set(host, acc);
    }

    acc.total += 1;

    const tt = Number(r.ttms_ms);
    if (Number.isFinite(tt)) acc.ttms.push(tt);

    const crc = String(r.crc ?? "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    incMap(acc.crcCounts, crc, 1);

    const st = Number(r.edge_status);
    if (Number.isFinite(st) && st >= 100 && st <= 599) {
      incMap(acc.statusCounts, String(st), 1);
    }
  }

  const hostBreakdown = [...hostAgg.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, HOST_LIMIT)
    .map(([host, acc]) => ({
      host,
      totalRequests: acc.total,
      p95TtmsMs: percentile(acc.ttms, 95),
      p99TtmsMs: percentile(acc.ttms, 99),
      crcCounts: mapToTopObject(acc.crcCounts, CRC_PER_HOST_LIMIT),
      statusCounts: mapToTopObject(acc.statusCounts, STATUS_PER_HOST_LIMIT),
    }));

  // ✅ Optional but handy: flatten for “Top CRCs by host” tables
  // [{host, crc, count}]
  const crcByHost = [];
  for (const hb of hostBreakdown) {
    const host = hb.host;
    const crcCountsObj = hb.crcCounts || {};
    for (const crc of Object.keys(crcCountsObj)) {
      const count = Number(crcCountsObj[crc]) || 0;
      if (count > 0) crcByHost.push({ host, crc, count });
    }
  }
  crcByHost.sort((a, b) => b.count - a.count);

  // Evidence
  const evidence = [];
  if (errorCount > 0) {
    const topErr = topErrorsByCrc[0];
    if (topErr) evidence.push(`Error responses are dominated by \`${topErr[0]}\` (${topErr[1]} of ${errorCount}).`);
    evidence.push(`Error responses: ${errorCount}/${total} (${formatPct(errorRate)}).`);
  } else {
    evidence.push(`No 5xx responses observed.`);
  }
  evidence.push(`Cache hit ratio ${formatPct(hitRatio)} (miss ${formatPct(missRatio)}).`);
  evidence.push(`Latency p95/p99 TTMS = ${formatMs(p95)}/${formatMs(p99)}.`);

  // Pretty summary
  const header = `🧭 *CDN TRIAGE SUMMARY*`;
  const scopeLine = `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``;
  const windowLine = `• Window: \`${windowM}m\`  • Time (UTC): \`${startISO}\` → \`${endISO}\``;
  const filterLine = `• Filters: \`${prettyFilters(filtersArr)}\``;

  const trafficPerf = [
    `📊 *Traffic & Performance*`,
    `• Requests: *${formatInt(total)}*`,
    `• P95 TTMS: *${formatMs(p95)}*`,
    `• P99 TTMS: *${formatMs(p99)}*`,
    `• Cache Hit: *${formatPct(hitRatio)}*  (miss ${formatPct(missRatio)})`,
  ].join("\n");

  const statusBlock = [`🧮 *Response Codes*`, prettyStatusCounts(statusCountsPairs, 12)].join("\n");

  const breakdown = [
    `🧩 *Top breakdowns*`,
    `• service: ${topValuesPretty(filtered, "service", 4)}`,
    `• region: ${topValuesPretty(filtered, "region", 4)}`,
    `• pop: ${topValuesPretty(filtered, "pop", 4)}`,
    `• host: ${topValuesPretty(filtered, "host", 4)}`,
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
    dqWindow.unknown_host
  ) {
    dqLines.push(`⚠️ *Data Quality (window)*`);
    if (dqWindow.missing_edge_status) dqLines.push(`• missing edge_status: ${dqWindow.missing_edge_status}`);
    if (dqWindow.unknown_service) dqLines.push(`• unknown service: ${dqWindow.unknown_service}`);
    if (dqWindow.unknown_crc) dqLines.push(`• unknown crc: ${dqWindow.unknown_crc}`);
    if (dqWindow.unknown_region) dqLines.push(`• unknown region: ${dqWindow.unknown_region}`);
    if (dqWindow.unknown_pop) dqLines.push(`• unknown pop: ${dqWindow.unknown_pop}`);
    if (dqWindow.unknown_host) dqLines.push(`• unknown host: ${dqWindow.unknown_host}`);
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
      timeRangeUTC: { start: startISO, end: endISO },
      totalRequests: total,
      p95TtmsMs: p95,
      p99TtmsMs: p99,
      cacheHitPct: hitRatio,
      cacheMissPct: missRatio,

      // unchanged (used in summary block)
      statusCounts: statusCountsPairs.map(([code, count]) => ({ code: Number(code), count })),

      error5xxCount: errorCount,
      errorRatePct: errorRate,
      topCrcClass: topCrcClass.map(([k, v]) => ({ crc_class: k, count: v })),
      topErrorCrc: topErrorsByCrc.map(([k, v]) => ({ crc: k, count: v })),

      // ✅ timeseries includes statusCounts + crcCounts + hostCounts per bucket
      timeseries,

      // ✅ NEW window-level breakdowns (for your “P95/99 by host + CRC counts by host”)
      hostBreakdown,
      crcByHost,

      warnings,
      dataQuality: { all: dqAll, window: dqWindow },
      debug: dbg,
    },
  };
}
