// lib/clickhouse/runClickhouseTriage.ts
import { runMockClickhouseTriage } from "./runMockClickhouseTriage";

type Inputs = {
  partner?: string;
  service: string;
  region: string;
  pop: string;
  windowMinutes: number;
  debug: boolean;
};

function hasClickHouseEnv() {
  return Boolean(process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_USER && process.env.CLICKHOUSE_PASSWORD);
}

export async function runClickhouseTriage(inputs: Inputs) {
  // No creds yet → always mock
  if (!hasClickHouseEnv()) {
    return runMockClickhouseTriage(inputs);
  }

  // Later: replace this with runRealClickhouseTriage(inputs)
  throw new Error("Real ClickHouse not wired yet (env detected, but runner not implemented).");
}
