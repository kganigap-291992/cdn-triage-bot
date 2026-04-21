export type NormalizationResult = {
  rawText: string;
  normalizedText: string;
};

function normalizeBaseText(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\w\s:%/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeInput(input: string): NormalizationResult {
  let text = normalizeBaseText(input);

  const replacements: Array<[RegExp, string]> = [
    // -----------------------------
    // 1. Time normalization
    // -----------------------------
    [/\bhrs\b/g, "hours"],
    [/\bhr\b/g, "hour"],
    [/\bhts\b/g, "hours"],
    [/\bmins\b/g, "minutes"],
    [/\bmin\b/g, "minute"],

    [/\b(\d+)\s*h\b/g, "$1 hours"],
    [/\b(\d+)\s*hrs\b/g, "$1 hours"],
    [/\b(\d+)\s*hr\b/g, "$1 hour"],
    [/\b(\d+)\s*m\b/g, "$1 minutes"],
    [/\b(\d+)\s*mins\b/g, "$1 minutes"],
    [/\b(\d+)\s*min\b/g, "$1 minute"],

    // -----------------------------
    // 2. Domain / metric normalization
    // -----------------------------
    [/\bcache health\b/g, "ats"],
    [/\bcache behavior\b/g, "ats"],
    [/\bcache performance\b/g, "ats"],
    [/\bcache\b/g, "ats"],

    [/\b5xx\b/g, "errors"],
    [/\bslow\b/g, "latency"],
    [/\bdelay\b/g, "latency"],
    [/\btraffic\b/g, "requests"],

    // ATS operational family wording
    [/\bclient errors\b/g, "client_err"],
    [/\bclient error\b/g, "client_err"],
    [/\bclient err\b/g, "client_err"],

    [/\binfra errors\b/g, "infra_err"],
    [/\binfra error\b/g, "infra_err"],
    [/\binfra err\b/g, "infra_err"],

    // ATS raw codes
    [/\btcp miss\b/g, "tcp_miss"],
    [/\bdns fail\b/g, "err_dns_fail"],

    // -----------------------------
    // 3. Scope / schema normalization
    // -----------------------------
    [/\bus east\b/g, "us-east"],
    [/\bus west\b/g, "us-west"],
    [/\bus central\b/g, "us-central"],
    [/\beu west\b/g, "eu-west"],
    [/\beu central\b/g, "eu-central"],
    [/\bap south\b/g, "ap-south"],
    [/\bap northeast\b/g, "ap-northeast"],
    [/\bsa east\b/g, "sa-east"],

    // Keep parser-friendly wording
    [/\buser agent\b/g, "ua family"],
    [/\bcontent type\b/g, "contentType"],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/\s+/g, " ").trim();

  return {
    rawText: input,
    normalizedText: text,
  };
}