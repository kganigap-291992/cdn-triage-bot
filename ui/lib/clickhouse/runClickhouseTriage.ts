// lib/clickhouse/runClickhouseTriage.ts
// Decision point: mock vs real ClickHouse execution.
// For public repo / no credentials, always use mock runner.

import { runMockClickhouseTriage } from "./runMockClickhouseTriage";

export type ClickhouseTriageInputs = {
  partner: string;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;
};

export type ClickhouseTriageResult = {
  summaryText: string;
  metricsJson: any;
  // Optional debug payload for UI + route.ts (_debug.sql)
  debugSql?: string;
};

export async function runClickhouseTriage(
  inputs: ClickhouseTriageInputs
): Promise<ClickhouseTriageResult> {
  // Later (when credentials exist), you can switch here:
  // if (process.env.CLICKHOUSE_URL) return runRealClickhouseTriage(inputs);
  // else return runMockClickhouseTriage(inputs);

  return runMockClickhouseTriage(inputs);
}
