# Cachey — Query Inventory (Locked Contract)

## Status
- Phase: Post Compare Backbone (13-query system)
- Source of Truth: `lib/clickhouse/sqlBuilder.ts`
- Execution Mode: request-sql via proxy
- Contract Status: LOCKED

---

## 🔢 Query Inventory (Current)

### Core Queries (Required)

1. aggregate_current
2. aggregate_previous

3. timeseries_current
4. timeseries_previous

5. region_breakdown
6. pop_breakdown
7. ua_breakdown
8. content_breakdown

9. status_over_time_current
10. status_over_time_previous

11. crc_over_time_current
12. crc_over_time_previous

13. host_summary (optional / partial support)

---

## 📦 Canonical Response Contract (metricsJson)

metricsJson = {
  totalRequests: number
  p50TtmsMs: number | null
  p95TtmsMs: number | null
  p99TtmsMs: number | null
  cacheHitRate: number | null
  error5xxCount: number
  crcErrorCount: number
  errorRatePct: number
  successRatePct: number

  regionBreakdown: Breakdown[]
  popBreakdown: Breakdown[]
  uaBreakdown: Breakdown[]
  contentBreakdown: Breakdown[]

  timeseries: {
    bucketSeconds: number
    startTs: string | null
    endTs: string | null
    points: TimeseriesPoint[]

    statusCodeSeries: string[]
    hostSeries: HostPoint[]
    crcSeries: CrcPoint[]

    statusOverTime: StatusPoint[]
  }

  previousWindow: {
    totalRequests: number
    p50TtmsMs: number | null
    p95TtmsMs: number | null
    p99TtmsMs: number | null
    cacheHitRate: number | null
    error5xxCount: number
    crcErrorCount: number
    errorRatePct: number
    successRatePct: number

    timeRangeUTC: {
      start: string | null
      end: string | null
    }

    timeseries: {
      bucketSeconds: number
      startTs: string | null
      endTs: string | null
      points: TimeseriesPoint[]

      statusOverTime: StatusPoint[]
      crcOverTime: CrcPoint[]
    }
  }

  debug: DebugInfo
}

---

## 📏 Guaranteed Behaviors (LOCKED)

- All timestamps are UTC ISO strings
- Timeseries is sorted ascending by `ts`
- Missing data → empty arrays (never undefined)
- Breakdown keys are normalized (no null/empty keys)
- Previous window uses same bucket size as current
- Query count must match debug.queryCount
- Compare queries always included in 13-query mode
- statusOverTime and crcOverTime always aligned to bucket size

---

## 🚫 Not Supported (Yet)

- Cross-region comparisons (us-east vs us-west)
- ML anomaly detection
- Confidence scoring
- Correlation analysis (latency vs errors vs cache)
- Multi-dimensional joins across breakdowns
- Real-time streaming (batch only)

---

## 🔮 Next Planned Queries

- host_summary (complete support)
- status distribution percentages
- cache breakdown by status
- regional compare queries (future phase)

---

## 🧠 Notes

- This file is the contract for:
  - UI rendering
  - graph system
  - agents/swarm
  - LLM explanation layer

- DO NOT change field names without updating:
  - sqlBuilder
  - proxy normalization
  - UI consumers

- This contract reflects:
  - 13-query deterministic system
  - request-sql proxy execution
  - ClickHouse-backed truth
