// ui/lib/triage/contracts.ts

export type DataSource = "csv" | "clickhouse";

export type TriageRequest = {
  query?: string;

  dataSource?: DataSource;

  partner?: string;
  service?: string;
  region?: string;
  pop?: string;
  windowMinutes?: number;

  // legacy/debug support
  csvUrl?: string;

  // optional (route supports it)
  debug?: boolean;
};

export type TriageOkResponse = {
  ok: true;

  summary: string;
  metricsJson: any;

  evidence?: any;
  sql?: { queries: string[] };

  // legacy compat during migration
  summaryText?: string;
};

export type TriageErrResponse = {
  ok: false;
  error: string;
};

export type TriageResponse = TriageOkResponse | TriageErrResponse;