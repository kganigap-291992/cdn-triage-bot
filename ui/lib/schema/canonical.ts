// lib/schema/canonical.ts
export const CANON = {
  partners: ["partner_01","partner_02","partner_03","partner_04","partner_05","partner_06"] as const,

  services: ["live","vod","dvr","eas","live_ott","app_backend"] as const,

  regions: ["us-east","us-west","us-central","eu-west","eu-central","ap-south","ap-northeast","sa-east"] as const,

  contentTypes: ["manifest","segment","api"] as const,
  uaFamilies: ["stb","mobile","web","smart_tv","console"] as const,

  pops: Array.from({ length: 20 }, (_, i) => `pop_${String(i + 1).padStart(3, "0")}`) as string[],
};

export type CanonPartner = (typeof CANON.partners)[number];
export type CanonService = (typeof CANON.services)[number];

export function isCanonPartner(x: unknown): x is CanonPartner {
  return typeof x === "string" && (CANON.partners as readonly string[]).includes(x);
}
export function isCanonService(x: unknown): x is CanonService {
  return typeof x === "string" && (CANON.services as readonly string[]).includes(x);
}