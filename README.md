# CDN Incident Triage Bot

**V1 (n8n + Slack) → V2 (Standalone UI + API)**

An automated CDN incident triage system that analyzes delivery telemetry (edge, mid-tier, cache, URL patterns, and client signals) and produces **evidence-backed diagnosis and drill-down insights**.

This project mirrors real-world CDN/video operations and demonstrates how operational analytics, automation, and tooling evolution can be applied safely in production-style workflows.

---

## 📋 Table of Contents

- [Data Safety](#data-safety)
- [Why This Project Exists](#why-this-project-exists)
- [V1 — n8n + Slack (Prototype Phase)](#v1--n8n--slack-prototype-phase)
- [🤖 LLM Integration & Intelligent Chat](#-llm-integration--intelligent-chat)
- [Architecture](#architecture)
- [Getting Started](#getting-started)

---

## Data Safety

All telemetry used in this project is **synthetically generated** to mirror real-world CDN traffic patterns.

* No production logs
* No customer data
* No proprietary systems

---

## Why This Project Exists

CDN incident triage is often:

* manual and time-consuming
* dependent on tribal knowledge
* difficult to standardize across teams

Engineers must correlate:

* edge vs upstream errors
* cache behavior
* latency spikes
* URL types (manifest vs segment)
* regional POP failures
* client / User-Agent patterns

**This project automates first-level triage** using deterministic rules, clear metrics, and explainable summaries.

---

# V1 — n8n + Slack (Prototype Phase)

V1 focused on **speed of iteration and signal validation**.

### Why a UI Was Required (Beyond Automation)

While n8n worked well for automated, one-shot triage, it is not designed for interactive or conversational workflows.

Chat-based triage requires:

* deterministic and reproducible metrics
* explicit request/response boundaries
* inspectable intermediate state
* clear separation between computation and explanation

The move to a UI + API architecture in V2 was a prerequisite for any future chat or agent-based interface. The UI externalizes system state and makes reasoning observable, allowing conversational layers to sit on top without compromising correctness.

## V1 High-Level Architecture

```
flowchart LR
    A[Slack<br/>/triage command] -->|HTTP POST| B[n8n Webhook]
    B --> C[Parser<br/>Parse filters & window]
    C --> D[HTTP Request<br/>Fetch CSV]
    D --> E[Metrics Engine<br/>Errors & P95 TTMS]
    E --> F[Slack<br/>Summary Response]
```

---

# 🤖 LLM Integration & Intelligent Chat

## Overview

The CDN Triage Bot features an integrated Large Language Model (LLM) powered assistant named **Cachey 🤖** that enables natural language interaction and intelligent incident triage through conversational interfaces.

---

## 🚀 Key Features

### 1. OpenRouter LLM Integration

Seamless integration with OpenRouter API for robust model access:

- **Multi-model support** with automatic fallback for reliability
- **Automatic retry handling** for rate limits (HTTP 429)
- **Environment-based configuration** for easy deployment

**Configuration:**
```env
OPENROUTER_API_KEY=your_api_key_here
OPENROUTER_MODELS=anthropic/claude-3.5-sonnet,openai/gpt-4
OPENROUTER_SITE_URL=https://your-app.com
OPENROUTER_APP_NAME=CDN Triage Bot
```

---

### 2. Dedicated Chat API Endpoint

**Route:** `/api/chat`

Handles intelligent conversation and incident parsing with:

- **Message history management** for contextual responses
- **Dynamic context injection** (regions, POPs, partners)
- **Model fallback mechanism** for high availability
- **Response normalization** for consistent output

**Key capabilities:**
- General conversational interaction
- Structured incident triage parsing
- Intelligent routing between operational modes

---

### 3. Dual-Mode Chat System

The chat system operates in two intelligent modes based on user intent:

#### A. General Chat Mode

**Used for:**
- Greetings and casual conversation
- Application questions and help requests
- High-level system discussions

**Features:**
- Balanced temperature (~0.5) for natural responses
- Concise replies (1-2 sentences)
- Automatic greeting detection
- Anti-rambling safeguards
- Professional tone maintenance

**Example interaction:**
```
User: hi
Cachey: Hey 👋 I'm Cachey 🤖 — your personal CDN bot. What would you like to check?
```

#### B. Triage Parsing Mode

**Activated for:** Incident-related queries

**Features:**
- Deterministic JSON-only output
- Temperature = 0 for maximum stability
- Strict schema enforcement
- Context-aware parsing with real-time validation
- ClickHouse partner verification

**Parsed output structure:**
```json
{
  "service": "live | vod | all",
  "region": "string",
  "pop": "string",
  "timeWindow": "string",
  "partner": "string",
  "requiresFollowUp": boolean
}
```

---

### 4. Intelligent Intent Detection

Advanced classification system to distinguish between:

- ✅ Casual conversation
- 📊 Monitoring queries
- 🚨 Incident triage requests

**Benefits:**
- Prevents unnecessary LLM parsing calls
- Improves response accuracy
- Reduces latency for simple queries
- Optimizes API usage

---

### 5. Assistant Personality & UX

**Identity:**
- **Name:** Cachey 🤖
- **Role:** Personal CDN Triage Assistant

**Behavior guidelines:**
- ✅ Professional during incidents
- ✅ Concise and helpful responses
- ❌ No unnecessary greetings
- ❌ No repetitive self-introductions
- ❌ No feature dumping
- 😄 Subtle humor only when systems are healthy

This ensures credibility during critical outages while maintaining an approachable demo experience.

---

### 6. Safety & Reliability

**Output normalization safeguards:**

- **JSON recovery** for malformed LLM responses
- **Regex-based extraction** for partner names
- **Reply sanitization** to remove artifacts
- **Token limits** to prevent excessive responses
- **Strict validation** against known schema

**Benefits:**
- Reduces hallucinations
- Improves parsing stability
- Ensures consistent behavior
- Handles edge cases gracefully

---

## 🛠️ Technical Architecture

```
User Input
    ↓
Intent Detection
    ↓
    ├─→ General Chat Mode (conversational)
    │   └─→ LLM Response (temp: 0.5)
    │
    └─→ Triage Mode (incident parsing)
        └─→ LLM Parsing (temp: 0) → JSON validation → ClickHouse verification
```

---

## 📋 Usage Examples

### General Conversation
```
User: What can you help me with?
Cachey: I can help you check CDN status, analyze incidents, and monitor traffic across regions and POPs.
```

### Incident Triage
```
User: check live streaming issues in APAC for the last hour
Cachey: [Parsed structure]
{
  "service": "live",
  "region": "APAC",
  "timeWindow": "1h",
  "partner": null
}
```

---
