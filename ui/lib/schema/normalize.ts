// ui/lib/schema/normalize.ts
import {
  CANON,
  CANON_META,
  type CanonPartner,
  type CanonService,
} from "@/lib/schema/canonical";

type CanonValue = CanonPartner | CanonService;

type AliasMeta<TValue extends string> = {
  value: TValue;
  label: string;
  aliases: readonly string[];
};

type ResolveMatch<TValue extends string> = {
  value: TValue;
  label: string;
  matchedAlias: string;
};

function normalizeFreeText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAliasCandidates<TValue extends string>(
  meta: readonly AliasMeta<TValue>[]
): Array<ResolveMatch<TValue> & { normalizedAlias: string }> {
  const out: Array<ResolveMatch<TValue> & { normalizedAlias: string }> = [];

  for (const item of meta) {
    const canonicalAlias = normalizeFreeText(item.value);
    out.push({
      value: item.value,
      label: item.label,
      matchedAlias: item.value,
      normalizedAlias: canonicalAlias,
    });

    for (const alias of item.aliases) {
      const normalizedAlias = normalizeFreeText(alias);
      if (!normalizedAlias) continue;

      out.push({
        value: item.value,
        label: item.label,
        matchedAlias: alias,
        normalizedAlias,
      });
    }
  }

  out.sort((a, b) => b.normalizedAlias.length - a.normalizedAlias.length);
  return out;
}

function hasTokenBoundaryMatch(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${escaped}(?=$|\\s)`, "i");
  return re.test(haystack);
}

function resolveFromMeta<TValue extends string>(
  rawText: string,
  meta: readonly AliasMeta<TValue>[]
): ResolveMatch<TValue> | null {
  const normalizedText = normalizeFreeText(rawText);
  if (!normalizedText) return null;

  const candidates = buildAliasCandidates(meta);

  for (const candidate of candidates) {
    if (hasTokenBoundaryMatch(normalizedText, candidate.normalizedAlias)) {
      return {
        value: candidate.value,
        label: candidate.label,
        matchedAlias: candidate.matchedAlias,
      };
    }
  }

  return null;
}

export type PartnerResolveResult = ResolveMatch<CanonPartner>;
export type ServiceResolveResult = ResolveMatch<CanonService>;

export function normalizeInputText(input: string): string {
  return normalizeFreeText(input);
}

export function resolvePartner(rawText: string): PartnerResolveResult | null {
  return resolveFromMeta(rawText, CANON_META.partners);
}

export function resolveService(rawText: string): ServiceResolveResult | null {
  return resolveFromMeta(rawText, CANON_META.services);
}

export function isCanonicalPartnerValue(x: unknown): x is CanonPartner {
  return typeof x === "string" && (CANON.partners as readonly string[]).includes(x);
}

export function isCanonicalServiceValue(x: unknown): x is CanonService {
  return typeof x === "string" && (CANON.services as readonly string[]).includes(x);
}

export function normalizePartnerValue(rawValue: string): CanonPartner | null {
  const direct = String(rawValue || "").trim();
  if (isCanonicalPartnerValue(direct)) return direct;
  return resolvePartner(rawValue)?.value ?? null;
}

export function normalizeServiceValue(rawValue: string): CanonService | null {
  const direct = String(rawValue || "").trim();
  if (isCanonicalServiceValue(direct)) return direct;
  return resolveService(rawValue)?.value ?? null;
}