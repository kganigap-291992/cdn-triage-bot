# Cachey — Deterministic Incident Triage Engine

**Status:** Pre-LLM Architecture  
**Purpose:** Convert ClickHouse telemetry into a structured service health assessment.

---

# Overview

Cachey is a **deterministic incident triage engine** built on top of ClickHouse telemetry.

Instead of relying on an LLM to infer system behavior, Cachey:

1. Normalizes user questions into structured scope
2. Executes deterministic ClickHouse queries
3. Runs specialized analysis agents
4. Produces a structured **IncidentAssessment**
5. Optionally uses an LLM later only for narration

Key goals:

- Deterministic analysis
- SQL-backed truth
- Explainability
- Reproducibility
- LLM optional

---

# High Level Architecture

```
User Question
      │
      ▼
Normalization Layer
(scope + time resolution)
      │
      ▼
ClickHouse Query Layer
(shared metrics + breakdown queries)
      │
      ▼
EvidenceBundle
(all telemetry evidence)
      │
      ▼
Deterministic Agents
(scope / traffic / latency / errors / cache)
      │
      ▼
IncidentAssessment
(service health verdict)
      │
      ▼
UI Cards
(Graphs + SQL Evidence)
```

Future phase:

```
IncidentAssessment
        ↓
LLM Narrator
        ↓
Natural Language Explanation
```

---

# ClickHouse Tables

Cachey uses two tables depending on the time window.

| Table | Resolution | Usage |
|------|------|------|
| `cachey.raw_minute` | 1 minute | windows ≤ 6 hours |
| `cachey.agg_15m` | 15 minutes | windows > 6 hours |

---

# Table Selection Logic

```
if window <= 6h:
    table = cachey.raw_minute
    bucketSeconds = 60
else:
    table = cachey.agg_15m
    bucketSeconds = 900
```

Minimum investigation window:

```
minWindow = 30 minutes
```

---

# Shared Metrics Query

Used by most agents.

```sql
SELECT
  ts AS time,
  requests,
  error_rate,
  p95_latency,
  p99_latency,
  cache_hit_rate
FROM {table}
WHERE
  partner = '{partner}'
  AND service = '{service}'
  AND ts BETWEEN {startTs} AND {endTs}
ORDER BY ts
```

The same query runs for:

- **current window**
- **previous comparison window**

Comparison rule:

```
comparisonWindow = investigationWindow
```

Example:

```
current window : 2h
previous window: previous 2h
```

---

# Breakdown Queries

These help determine **blast radius and localization**.

## Traffic by Region

```sql
SELECT region, count() AS requests
FROM {table}
WHERE {scopeFilter}
GROUP BY region
ORDER BY requests DESC
```

## Traffic by POP

```sql
SELECT pop, count() AS requests
FROM {table}
WHERE {scopeFilter}
GROUP BY pop
ORDER BY requests DESC
```

## Worst POP Latency

```sql
SELECT
 pop,
 quantile(0.95)(latency_ms) AS p95,
 quantile(0.99)(latency_ms) AS p99
FROM {table}
WHERE {scopeFilter}
GROUP BY pop
ORDER BY p95 DESC
LIMIT 5
```

## Worst POP Errors

```sql
SELECT
 pop,
 countIf(status >= 500) / count() AS error_rate
FROM {table}
WHERE {scopeFilter}
GROUP BY pop
ORDER BY error_rate DESC
LIMIT 5
```

## Worst POP Cache Hit

```sql
SELECT
 pop,
 countIf(cache_status='HIT') / count() AS hit_rate
FROM {table}
WHERE {scopeFilter}
GROUP BY pop
ORDER BY hit_rate ASC
LIMIT 5
```

---

# Normalization Layer

User questions are converted into structured filters.

Example user question:

```
How was partner_01 live last night?
```

Normalized scope:

```
partner: partner_01
service: live
region: all
pop: all
startTs: <resolved>
endTs: <resolved>
```

Fields:

| Field | Meaning |
|------|------|
| partner | partner identifier |
| service | service type |
| region | region filter |
| pop | POP filter |
| startTs | investigation window start |
| endTs | investigation window end |

---

# Evidence Bundle

The **EvidenceBundle** is the structured dataset produced by the query runner.

It contains all telemetry evidence required by deterministic agents.

Instead of each agent querying ClickHouse independently, the system retrieves all necessary data once and packages it into a shared bundle.

Agents then analyze the same evidence set to produce findings.

Architecture flow:

```
Normalization
      ↓
Query Runner
      ↓
EvidenceBundle
      ↓
Deterministic Agents
```

---

# EvidenceBundle Contract

```
type EvidenceBundle = {

  normalizedScope: NormalizedScope

  windowInfo: {
    windowMinutes: number
    bucketSeconds: number
    sampleCount: number
  }

  currentMetrics: TimeSeriesPoint[]
  previousMetrics?: TimeSeriesPoint[]

  derivedMetrics: {
    requestsTotal: number
    p95Avg: number
    p95Max: number
    p99Max: number
    errorRateAvg: number
    cacheHitAvg: number
  }

  derivedMetricsPrevious?: {
    requestsTotal: number
    p95Avg: number
    errorRateAvg: number
    cacheHitAvg: number
  }

  regionBreakdown: Array<{
    region: string
    requests: number
  }>

  popBreakdown: Array<{
    pop: string
    requests: number
  }>

  worstLatency: Array<{
    pop: string
    p95: number
    p99: number
  }>

  worstErrors: Array<{
    pop: string
    errorRate: number
  }>

  worstCache: Array<{
    pop: string
    hitRate: number
  }>

  diagnostics: {
    runId: string
    source: "clickhouse-proxy" | "local-mock"
    runnerVersion: string
    tableUsed: string
    comparisonAvailable: boolean
    dataCompleteness: "full" | "partial" | "sparse"
    notes: string[]
  }

  sql: {
    currentMetrics: string
    previousMetrics?: string
    regionBreakdown: string
    popBreakdown: string
    worstLatency: string
    worstErrors: string
    worstCache: string
  }

}
```

---

# Deterministic Agents

Five agents analyze telemetry.

| Agent | Role |
|------|------|
| Scope Agent | determine traffic footprint |
| Traffic Agent | detect request volume anomalies |
| Latency Agent | detect p95/p99 degradation |
| Errors Agent | detect error spikes |
| Cache Agent | detect cache efficiency drops |

Agents consume the **EvidenceBundle** and produce structured findings.

Agents **never query the database directly**.

---

# AgentResult Contract

```
type AgentResult = {
  agentId: "scope" | "traffic" | "latency" | "errors" | "cache"
  title: string
  status: "ok" | "warn" | "critical"
  summary: string
  metrics?: Record<string, number | string>
  graphs?: AgentGraph[]
  evidence?: string[]
  sql?: string[]
}
```

---

# Graph Model

Graphs provide visual proof of metric behavior.

```
type AgentGraph = {
  id: string
  title: string
  metric: string
  current: TimeSeriesPoint[]
  previous?: TimeSeriesPoint[]
}
```

Example latency trend:

```
time      p95
19:00     420
19:05     910
19:10     870
```

---

# SQL Evidence

Every agent exposes the SQL queries used for its findings.

Example:

```
1) Shared metrics query
SELECT ...

2) Worst POP latency query
SELECT ...
```

This guarantees **truthfulness and reproducibility**.

---

# IncidentAssessment Contract

Final structured output of the triage engine.

```
type IncidentAssessment = {

  overallStatus: "ok" | "warn" | "critical"

  primarySignal: "traffic" | "latency" | "errors" | "cache" | "mixed"

  blastRadius: {
    regionCount: number
    popCount: number
    topRegions: string[]
    topPops: string[]
  }

  keyFindings: string[]

  agents: AgentResult[]

  summary: string

  metadata: {
    table: string
    bucketSeconds: number
    timeMode: "relative" | "absolute"
    startTs: string
    endTs: string
    compareStartTs?: string
    compareEndTs?: string
  }
}
```

---

# Trust Model

Cachey provides **three levels of truth**.

1. **Summary** – human readable explanation  
2. **Graphs** – visual metric proof  
3. **SQL Evidence** – raw queries used  

This prevents hallucination and ensures explainability.

---

# Future LLM Integration

The LLM never performs analysis.

```
IncidentAssessment
        ↓
LLM Narrator
        ↓
Readable explanation
```

LLM responsibilities:

- Rewrite summaries
- Improve readability
- Provide conversational responses

LLM **never**:

- queries the database
- computes metrics
- determines health status

---

# Key Design Principles

- Deterministic analysis first
- SQL as the source of truth
- LLM optional
- Evidence always visible
- Clear separation of layers

```
Retrieval
→ Analysis
→ Assessment
→ Explanation
```

---
