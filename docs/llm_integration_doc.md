# Cachey — LLM Narrator Integration Design

## Overview

Cachey uses a **deterministic-first architecture** where:

* Parser → decides intent (lane)
* Deterministic engine → computes truth (metrics, agents, evidence)
* UI → renders graphs/tables
* LLM → **narrates** the result (does not compute or decide)

---

## Core Principle

```txt
Deterministic System = Source of Truth
LLM = Narrator / Explainer
```

LLM must **never**:

* Generate SQL
* Infer schema
* Compute metrics
* Override agent decisions

LLM must only:

* Explain results
* Summarize findings
* Suggest next actions
* Improve readability

---

## System Flow

```txt
User Input
   ↓
Parser (parseInput.ts)
   ↓
Lane Selection (triage / exploration / drill / compare / explain)
   ↓
Deterministic Engine (SQL + agents)
   ↓
EvidenceBundle
   ↓
UI renders card (graphs/tables)
   ↓
NarrationPayload built
   ↓
LLM generates explanation
   ↓
UI displays narration inside card
```

---

## Universal Narration Payload

All LLM calls use a shared structure:

```ts
type NarrationPayload = {
  userQuestion: string;
  parsedIntent: string;

  cardType: "triage" | "exploration" | "drill" | "compare" | "explain" | "status";

  activeScope: {
    partner: string;
    service: string;
    region: string;
    pop: string;
  };

  timeWindow: {
    label: string;
    actualStart: string;
    actualEnd: string;
  };

  confidence: "high" | "medium" | "low";

  deterministicSummary: string;
  keyFindings: string[];

  agentOutputs: Record<string, string>;

  importantMetrics: Record<string, number | string>;

  evidenceUsed: string[];

  allowedNextActions: string[];
};
```

---

## Payload by Card Type

### 1. Triage Payload

Used for: full triage card narration

```ts
{
  overallState: string;
  primarySignal: string;

  metrics: {
    requests: number;
    p95: number;
    p99: number;
    errorRate: number;
    cacheHitRate: number;
  };

  atsSummary: {
    hit: number;
    miss: number;
    refresh: number;
    clientErr: number;
    infraErr: number;
  };

  blastRadius: {
    regions: number;
    pops: number;
  };

  agentOutputs: {
    scope: string;
    traffic: string;
    latency: string;
    errors: string;
    cache: string;
  };

  keyFindings: string[];
}
```

Purpose:

> Explain what is happening and what is driving the incident.

---

### 2. Exploration Payload

Used for: graph/table explanations

```ts
{
  metric: string;
  view: "timeseries" | "breakdown" | "compare";
  dimension?: string;

  summary: string;

  seriesSummary: {
    latest: number;
    min?: number;
    max?: number;
    trend?: "up" | "down" | "stable";
  };

  rowsSummary?: string[];

  confidenceHint?: string;
}
```

Purpose:

> Explain the graph or breakdown the user requested.

---

### 3. Drill Payload

Used for: worst entity / drill-down

```ts
{
  drillType: "worst_region" | "worst_pop" | "worst_ua" | "worst_content" | "worst_host";

  selectedEntity: string;

  topMetrics: {
    requests: number;
    p95: number;
    errorRate: number;
    cacheHitRate: number;
  };

  comparisonContext: string;

  rowsSummary: string[];

  parentTriageSummary: string;
}
```

Purpose:

> Explain why this entity is the worst.

---

### 4. Compare Payload

Used for: time comparison

```ts
{
  metric: string;

  current: number;
  previous: number;

  delta: number;
  direction: "up" | "down";

  context: string;
}
```

Purpose:

> Explain what changed and whether it matters.

---

### 5. Explain Payload

Used for: “why” / “what happened”

```ts
{
  primarySignal: string;

  agentOutputs: Record<string, string>;

  keyFindings: string[];

  supportingMetrics: Record<string, number>;

  userQuestion: string;
}
```

Purpose:

> Answer user’s question using latest triage result.

---

### 6. Status Breakdown Payload

```ts
{
  mode: "aggregate" | "region" | "pop" | "host";

  statusCounts: Record<string, number>;

  totalRequests: number;

  dominantStatuses: string[];

  interpretationHint: string;
}
```

Purpose:

> Explain status distribution and failures.

---

## LLM Prompt Structure

### System Prompt

```txt
You are Cachey’s narrator.

Rules:
- Use ONLY the provided evidence
- Do NOT invent metrics
- Do NOT contradict agent outputs
- Be concise and operational
- Focus on what matters to debugging
```

---

### Input Template

```txt
User Question:
{userQuestion}

Context:
{scope + timeWindow}

Agents:
{agentOutputs}

Key Findings:
{keyFindings}

Metrics:
{importantMetrics}

Evidence:
{evidenceUsed}
```

---

### Output Structure

```ts
type NarrationOutput = {
  explanation: string;
  evidenceUsed: string[];
  nextActions: string[];
};
```

---

## What NOT to Send to LLM

Avoid sending:

* Full SQL queries
* Large timeseries arrays
* Full UI text blobs
* Raw unprocessed logs

Instead:

* Send summaries
* Send top-N rows
* Send derived metrics

---

## Design Philosophy

```txt
Metrics → Agents → Truth
Truth → LLM → Explanation
Explanation → UI → User
```

---
