// lib/schema/canonical.ts
export const CANON = {
  partners: [
    "partner_01",
    "partner_02",
    "partner_03",
    "partner_04",
    "partner_05",
    "partner_06",
  ] as const,

  services: ["live", "vod", "dvr", "eas", "live_ott", "app_backend"] as const,

  regions: [
    "us-east",
    "us-west",
    "us-central",
    "eu-west",
    "eu-central",
    "ap-south",
    "ap-northeast",
    "sa-east",
  ] as const,

  contentTypes: ["manifest", "segment", "api"] as const,
  uaFamilies: ["stb", "mobile", "web", "smart_tv", "console"] as const,

  pops: Array.from(
    { length: 20 },
    (_, i) => `pop_${String(i + 1).padStart(3, "0")}`
  ) as string[],
};

export type CanonPartner = (typeof CANON.partners)[number];
export type CanonService = (typeof CANON.services)[number];

export function isCanonPartner(x: unknown): x is CanonPartner {
  return typeof x === "string" && (CANON.partners as readonly string[]).includes(x);
}

export function isCanonService(x: unknown): x is CanonService {
  return typeof x === "string" && (CANON.services as readonly string[]).includes(x);
}

export type CanonAliasMeta<TValue extends string> = {
  value: TValue;
  label: string;
  aliases: readonly string[];
};

/**
 * Parallel metadata for human-friendly parsing.
 *
 * IMPORTANT:
 * - Keep CANON arrays above unchanged for backward compatibility.
 * - These metadata exports are input-side helpers only.
 * - Only canonical values should cross the /api/triage boundary.
 * - Aliases here should stay explicit and low-ambiguity.
 */
export const CANON_META = {
  partners: [
    {
      value: "partner_01",
      label: "Partner 1",
      aliases: ["partner 1", "partner1", "p1"],
    },
    {
      value: "partner_02",
      label: "Partner 2",
      aliases: ["partner 2", "partner2", "p2"],
    },
    {
      value: "partner_03",
      label: "Partner 3",
      aliases: ["partner 3", "partner3", "p3"],
    },
    {
      value: "partner_04",
      label: "Partner 4",
      aliases: ["partner 4", "partner4", "p4"],
    },
    {
      value: "partner_05",
      label: "Partner 5",
      aliases: ["partner 5", "partner5", "p5"],
    },
    {
      value: "partner_06",
      label: "Partner 6",
      aliases: ["partner 6", "partner6", "p6"],
    },
  ] as const satisfies readonly CanonAliasMeta<CanonPartner>[],

  services: [
    {
      value: "live",
      label: "Live",
      aliases: ["linear", "live tv", "live-tv"],
    },
    {
      value: "vod",
      label: "VOD",
      aliases: ["on demand", "ondemand"],
    },
    {
      value: "dvr",
      label: "DVR",
      aliases: ["cdvr", "recording", "recordings"],
    },
    {
      value: "eas",
      label: "EAS",
      aliases: [],
    },
    {
      value: "live_ott",
      label: "Live OTT",
      aliases: ["tve", "ott"],
    },
    {
      value: "app_backend",
      label: "App Backend",
      aliases: [],
    },
  ] as const satisfies readonly CanonAliasMeta<CanonService>[],
} as const;