// ui/lib/formatters/statusFormatter.ts

export type StatusCounts = Record<string, number>;

const ORDER = [
  "200", "206", "304",
  "403", "404", "429",
  "500", "502", "503", "504",
];

export function formatStatusCounts(status: StatusCounts | undefined): string {
  if (!status) return "No status counts found.";

  return ORDER
    .map((code) => {
      const val = status[code];
      if (val === undefined) return null;
      return `${code}=${val.toLocaleString()}`;
    })
    .filter(Boolean)
    .join(" • ");
}