// ui/lib/triage/contracts.ts

export type DataSource = "csv" | "clickhouse";

export type TriageRequest = {
  // query can be empty for now (your UI doesn’t send it yet)
  query?: string;

  dataSource?: DataSource;

  partner?: string;
  service?: string; // keep string to avoid breaking current code
  region?: string;
  pop?: string;
  windowMinutes?: number;

  // legacy/debug support (keep additive)
  csvUrl?: string;
};

export type TriageResponse = {
  ok: boolean;

  // Canonical (new)
  summary?: string;
  metricsJson?: any;
  evidence?: any;
  sql?: { queries: string[] };

  // Legacy compatibility (old)
  summaryText?: string;

  // Errors
  error?: string;
};