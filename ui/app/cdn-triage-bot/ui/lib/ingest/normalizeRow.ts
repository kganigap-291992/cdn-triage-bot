export type NormalizedRow = {
  ts: number
  service: string
  region: string
  pop: string
  status: number | null
  ttms: number | null
  crc: string
}

export function normalizeRow(raw: Record<string, any>): NormalizedRow {
  return {
    ts: Date.parse(raw.ts || raw.timestamp || ""),
    service: raw.service ?? "unknown",
    region: raw.region ?? "unknown",
    pop: raw.pop ?? "unknown",

    // normalize status field names
    status:
      raw.status != null
        ? Number(raw.status)
        : raw.edge_status != null
        ? Number(raw.edge_status)
        : null,

    // normalize latency field names
    ttms:
      raw.ttms != null
        ? Number(raw.ttms)
        : raw.time_to_first_byte != null
        ? Number(raw.time_to_first_byte)
        : null,

    // normalize error classification
    crc: raw.crc ?? raw.error_reason ?? "other",
  }
}
