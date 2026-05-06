# Cachey AI Architecture — Layered Design

## Overview

Cachey uses a layered AI architecture to separate:
- Truth (deterministic system)
- Definitions (glossary)
- Reasoning (OpenAI)
- Conversation (NVIDIA)

This ensures correctness, safety, and controlled AI usage.

---

## Architecture Diagram

```
User Input
    ↓
Parser (Deterministic)
    ↓
Routing
 ├── Glossary → Deterministic Definitions
 ├── Knowledge → NVIDIA (General CDN Knowledge)
 ├── Bridge → NVIDIA / Template (Input Narration)
 ├── Explain → OpenAI GPT nano (Result Explanation)
 └── Triage / Compare / Drill / Exploration → Deterministic Execution
    ↓
Deterministic Execution (ClickHouse + Agents)
    ↓
Result Cards (Source of Truth)
    ↓
OpenAI Narration (Optional)
```

---

## Layer Responsibilities

### Truth Layer (Deterministic + Glossary)
- Metrics, incidents, severity
- SQL queries and ClickHouse
- EvidenceBundle
- Triage / Compare / Drill / Exploration results
- Glossary definitions (ATS, TCP_MISS, etc.)

---

### Reasoning Layer (OpenAI GPT nano)
- Explains deterministic results
- Summarizes incidents
- Answers "what happened" / "why"

---

### Conversation Layer (NVIDIA)
- Bridge messages (input narration)
- General CDN knowledge (beginner explanations)
- Makes chat feel natural and human-like

---

## Control Rules

- Deterministic system is the source of truth
- OpenAI explains truth
- NVIDIA provides conversational tone only
- Glossary overrides all definitions

---

## Summary

```
Truth Layer        → Deterministic + Glossary
Reasoning Layer    → OpenAI GPT nano
Conversation Layer → NVIDIA
```
