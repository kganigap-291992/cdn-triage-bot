// lib/triage/metricsEngine.js
// Ported from n8n Function node to a plain JS module.
// Returns { summaryText, metricsJson }.

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
  return filters.map(f => {
    if (f?.type === "range") return `${f.key}=${f.min}-${f.max}`;
    if (f?.type === "eq") return `${f.key}=${f.value}`;
    if (f?.type === "in") return `${f.key} in (${(f.values ?? []).join(",")})`;
    return `${f?.key ?? "filter"}`;
  }).join(", ");
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
    const set = (f.values ?? []).map(x => String(x).trim().toLowerCase());
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
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        out.push(cur); cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  const headers = splitCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, "").trim());

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

    // Numeric normalization
    if (obj.edge_status !== undefined) obj.edge_status = Number(obj.edge_status);
    if (obj.mid_status !== undefined) obj.mid_status = Number(obj.mid_status);
    if (obj.ttms_ms !== undefined) obj.ttms_ms = Number(obj.ttms_ms);
    if (obj.upstream_bytes !== undefined) obj.upstream_bytes = Number(obj.upstream_bytes);
    if (obj.edge_cache_hit !== undefined) obj.edge_cache_hit = Number(obj.edge_cache_hit);

    // Canonical dims
    obj.service = normLower(obj.delivery_service ?? obj.service) || "unknown";
    obj.crc = normUpper(obj.crc) || "UNKNOWN";
    obj.crc_class = deriveCrcClass(obj.crc);

    const rp = deriveRegionPopFromUrl(obj.url);
    obj.region = normLower(obj.region ?? rp.region) || "unknown";
    obj.pop = normLower(obj.pop ?? rp.pop) || "unknown";

    rows.push(obj);
  }

  return rows;
}

// ------------------------------------------------------------
// Debug helpers
// ------------------------------------------------------------
function buildDebugObj({ rows, inWindow, filtered, startISO, endISO, anchorISO, dq, warnings }) {
  const sample = (filtered[0] ?? inWindow[0] ?? null);
  const sampleCompact = sample ? {
    ts: sample.ts,
    service: sample.service,
    region: sample.region,
    pop: sample.pop,
    crc: sample.crc,
    crc_class: sample.crc_class,
    edge_status: sample.edge_status,
    ttms_ms: sample.ttms_ms,
    url: sample.url,
  } : null;

  return {
    rows_total: rows.length,
    rows_inWindow: inWindow.length,
    rows_filtered: filtered.length,
    time: { anchor: anchorISO, start: startISO, end: endISO },
    available: {
      service: topValuesPretty(inWindow, "service", 8),
      region: topValuesPretty(inWindow, "region", 8),
      pop: topValuesPretty(inWindow, "pop", 8),
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
  const w = (dbg.warnings?.length ? dbg.warnings.join(" | ") : "none");
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
    try { filtersArr = JSON.parse(filters); } catch { filtersArr = []; }
  } else filtersArr = [];

  if (!csvText) {
    throw new Error("No CSV text found.");
  }

  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw new Error("Parsed 0 rows from CSV. Check delimiter/quotes/header line.");
  }

  // Data quality counters (whole dataset)
  const dqAll = {
    invalid_ts: rows.filter(r => !r.ts || Number.isNaN(toMs(r.ts))).length,
    missing_edge_status: rows.filter(r => !Number.isFinite(r.edge_status)).length,
    unknown_service: rows.filter(r => r.service === "unknown").length,
    unknown_crc: rows.filter(r => r.crc === "UNKNOWN").length,
    unknown_region: rows.filter(r => r.region === "unknown").length,
    unknown_pop: rows.filter(r => r.pop === "unknown").length,
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

  const start = anchor - Number(windowMinutes) * 60 * 1000;
  const end = anchor;

  const inWindow = rows.filter(r => {
    const ms = toMs(r.ts);
    if (Number.isNaN(ms)) return false;
    return ms >= start && ms <= end;
  });

  const startISO = new Date(start).toISOString();
  const endISO = new Date(end).toISOString();
  const anchorISO = endISO;

  // Data quality counters (window)
  const dqWindow = {
    invalid_ts: inWindow.filter(r => !r.ts || Number.isNaN(toMs(r.ts))).length,
    missing_edge_status: inWindow.filter(r => !Number.isFinite(r.edge_status)).length,
    unknown_service: inWindow.filter(r => r.service === "unknown").length,
    unknown_crc: inWindow.filter(r => r.crc === "UNKNOWN").length,
    unknown_region: inWindow.filter(r => r.region === "unknown").length,
    unknown_pop: inWindow.filter(r => r.pop === "unknown").length,
  };

  // Apply filters + dimensions
  let filtered = inWindow
    .filter(r => matchDim(r.service, service))
    .filter(r => matchDim(r.region, region))
    .filter(r => matchDim(r.pop, pop));

  for (const f of filtersArr) {
    filtered = filtered.filter(r => passesFilter(r, f));
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
    warnings.push(`Some rows missing edge_status (${dqWindow.missing_edge_status}). Response code totals may not sum perfectly.`);
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

  // Empty window / no matches
  if (inWindow.length === 0) {
    const summaryText = [
      `🧭 *CDN TRIAGE SUMMARY*`,
      `No data found in requested time window.`,
      `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``,
      `• Window: \`${windowMinutes}m\`  • Filters: \`${prettyFilters(filtersArr)}\``,
      `• Time (UTC): \`${startISO}\` → \`${endISO}\``,
      ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map(w => `• ${w}`)] : []),
      ...(debug && dbg ? ["", "```", debugBlock(dbg), "```"] : []),
    ].join("\n");

    return {
      summaryText,
      metricsJson: {
        timeRangeUTC: { start: startISO, end: endISO },
        totalRequests: 0,
        p95TtmsMs: null,
        cacheHitPct: null,
        cacheMissPct: null,
        statusCounts: [],
        warnings,
        dataQuality: { all: dqAll, window: dqWindow },
        debug: dbg,
      },
    };
  }

  if (filtered.length === 0) {
    const summaryText = [
      `🧭 *CDN TRIAGE SUMMARY*`,
      `No rows matched your filters.`,
      `• Requested: service=\`${service}\` region=\`${region}\` pop=\`${pop}\` window=\`${windowMinutes}m\``,
      `• Filters: \`${prettyFilters(filtersArr)}\``,
      `• Available (this window):`,
      `   - service: ${topValuesPretty(inWindow, "service")}`,
      `   - region: ${topValuesPretty(inWindow, "region")}`,
      `   - pop: ${topValuesPretty(inWindow, "pop")}`,
      `   - crc_class: ${topValuesPretty(inWindow, "crc_class")}`,
      `   - edge_status: ${topValuesPretty(inWindow, "edge_status")}`,
      ...(warnings.length ? ["", `⚠️ *Warnings*`, ...warnings.map(w => `• ${w}`)] : []),
      ...(debug && dbg ? ["", "```", debugBlock(dbg), "```"] : []),
    ].join("\n");

    return {
      summaryText,
      metricsJson: {
        timeRangeUTC: { start: startISO, end: endISO },
        totalRequests: 0,
        p95TtmsMs: null,
        cacheHitPct: null,
        cacheMissPct: null,
        statusCounts: [],
        warnings,
        dataQuality: { all: dqAll, window: dqWindow },
        debug: dbg,
      },
    };
  }

  // Metrics
  const total = filtered.length;

  const ttmsVals = filtered.map(r => Number(r.ttms_ms)).filter(v => Number.isFinite(v));
  const p95 = percentile(ttmsVals, 95);

  const hitCount = filtered.filter(r => Number(r.edge_cache_hit) === 1).length;
  const hitRatio = total ? (hitCount / total) * 100 : null;

  const missCount = filtered.filter(r => Number(r.edge_cache_hit) === 0).length;
  const missRatio = total ? (missCount / total) * 100 : null;

  const statusCountsPairs = countBy(filtered, "edge_status");

  const errorRows = filtered.filter(r => Number(r.edge_status) >= 500);
  const errorCount = errorRows.length;
  const errorRate = total ? (errorCount / total) * 100 : null;

  const topCrcClass = topCounts(filtered, "crc_class", 4);
  const topErrorsByCrc = topCounts(errorRows, "crc", 4);

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
  evidence.push(`Latency p95 TTMS = ${formatMs(p95)}.`);

  // Pretty summary
  const header = `🧭 *CDN TRIAGE SUMMARY*`;
  const scopeLine = `• Scope: service=\`${service}\`  region=\`${region}\`  pop=\`${pop}\``;
  const windowLine = `• Window: \`${windowMinutes}m\`  • Time (UTC): \`${startISO}\` → \`${endISO}\``;
  const filterLine = `• Filters: \`${prettyFilters(filtersArr)}\``;

  const trafficPerf = [
    `📊 *Traffic & Performance*`,
    `• Requests: *${formatInt(total)}*`,
    `• P95 TTMS: *${formatMs(p95)}*`,
    `• Cache Hit: *${formatPct(hitRatio)}*  (miss ${formatPct(missRatio)})`,
  ].join("\n");

  const statusBlock = [
    `🧮 *Response Codes*`,
    prettyStatusCounts(statusCountsPairs, 12),
  ].join("\n");

  const breakdown = [
    `🧩 *Top breakdowns*`,
    `• service: ${topValuesPretty(filtered, "service", 4)}`,
    `• region: ${topValuesPretty(filtered, "region", 4)}`,
    `• pop: ${topValuesPretty(filtered, "pop", 4)}`,
    `• crc_class: ${topCrcClass.length ? topCrcClass.map(([v, c]) => `${v} (${c})`).join(", ") : "n/a"}`,
  ].join("\n");

  const evidenceBlock = [
    `🧾 *Evidence*`,
    ...evidence.map(x => `• ${x}`)
  ].join("\n");

  const dqLines = [];
  if (
    dqWindow.missing_edge_status ||
    dqWindow.unknown_service ||
    dqWindow.unknown_crc ||
    dqWindow.unknown_region ||
    dqWindow.unknown_pop
  ) {
    dqLines.push(`⚠️ *Data Quality (window)*`);
    if (dqWindow.missing_edge_status) dqLines.push(`• missing edge_status: ${dqWindow.missing_edge_status}`);
    if (dqWindow.unknown_service) dqLines.push(`• unknown service: ${dqWindow.unknown_service}`);
    if (dqWindow.unknown_crc) dqLines.push(`• unknown crc: ${dqWindow.unknown_crc}`);
    if (dqWindow.unknown_region) dqLines.push(`• unknown region: ${dqWindow.unknown_region}`);
    if (dqWindow.unknown_pop) dqLines.push(`• unknown pop: ${dqWindow.unknown_pop}`);
  }

  const warnLines = warnings.length ? [`⚠️ *Warnings*`, ...warnings.map(w => `• ${w}`)] : [];

  const debugSection = (debug && dbg)
    ? ["", "```", debugBlock(dbg), "```"].join("\n")
    : "";

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
    debugSection
  ].filter(Boolean).join("\n");

  return {
    summaryText,
    metricsJson: {
      timeRangeUTC: { start: startISO, end: endISO },
      totalRequests: total,
      p95TtmsMs: p95,
      cacheHitPct: hitRatio,
      cacheMissPct: missRatio,
      statusCounts: statusCountsPairs.map(([code, count]) => ({ code: Number(code), count })),
      topCrcClass: topCrcClass.map(([k, v]) => ({ crc_class: k, count: v })),
      topErrorCrc: topErrorsByCrc.map(([k, v]) => ({ crc: k, count: v })),
      warnings,
      dataQuality: { all: dqAll, window: dqWindow },
      debug: dbg,
    },
  };
}
