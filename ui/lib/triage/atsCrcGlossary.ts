// lib/triage/atsCrcGlossary.ts

export type GlossaryEntry = {
  title: string;          // e.g., "TCP_HIT"
  meaning: string;        // canonical definition
  opsHint?: string;       // optional: quick practical hint
};

export const ATS_CRC_GLOSSARY: Record<string, GlossaryEntry> = {
  tcp_hit: {
    title: "TCP_HIT",
    meaning:
      "A valid copy of the requested object was in the cache and Traffic Server sent the object to the client.",
    opsHint: "Healthy cache behavior. Expect lower origin traffic and lower latency.",
  },
  tcp_cf_hit: {
    title: "TCP_CF_HIT",
    meaning:
      "A valid copy of the requested object is being updated in the cache and Traffic Server sent the object to the client.",
    opsHint: "Often indicates background revalidation/refresh while still serving.",
  },
  tcp_miss: {
    title: "TCP_MISS",
    meaning:
      "The requested object was not in cache, so Traffic Server retrieved the object from the origin server (or a parent proxy) and sent it to the client.",
    opsHint: "Rising MISS can mean cold cache, cache-busting URLs, or short TTLs.",
  },
  tcp_refresh_hit: {
    title: "TCP_REFRESH_HIT",
    meaning:
      "The object was in the cache, but it was stale. Traffic Server made an if-modified-since request to the origin server and the origin server sent a 304 not-modified response. Traffic Server sent the cached object to the client.",
    opsHint: "Revalidation succeeded (304). Usually fine; check TTL/revalidate rate if it spikes.",
  },
  tcp_ref_fail_hit: {
    title: "TCP_REF_FAIL_HIT",
    meaning:
      "The object was in the cache but was stale. Traffic Server made an if-modified-since request to the origin server but the server did not respond. Traffic Server sent the cached object to the client.",
    opsHint: "Origin may be unhealthy/timeout. ATS served stale to protect clients.",
  },
  tcp_refresh_miss: {
    title: "TCP_REFRESH_MISS",
    meaning:
      "The object was in the cache but was stale. Traffic Server made an if-modified-since request to the origin server and the server returned a new object. Traffic Server served the new object to the client.",
    opsHint: "Revalidation resulted in new content. Can increase origin load if frequent.",
  },
  tcp_client_refresh: {
    title: "TCP_CLIENT_REFRESH",
    meaning:
      "The client issued a request with a no-cache header. Traffic Server obtained the requested object from the origin server and sent a copy to the client. Traffic Server deleted the previous copy of the object from cache.",
    opsHint: "Often indicates client/device forcing refresh (no-cache). Can look like cache thrash.",
  },
  tcp_ims_hit: {
    title: "TCP_IMS_HIT",
    meaning:
      "The client issued an if-modified-since request and the object was in cache and fresher than the IMS date, or an if-modified-since request to the origin server revealed the cached object was fresh. Traffic Server served the cached object to the client.",
    opsHint: "Conditional requests + cache satisfied it. Usually good.",
  },
  tcp_ims_miss: {
    title: "TCP_IMS_MISS",
    meaning:
      "The client issued an if-modified-since request and the object was either not in cache or was stale in cache. Traffic Server sent an if-modified-since request to the origin server and received the new object. Traffic Server sent the updated object to the client.",
    opsHint: "Conditional request but cache couldn’t satisfy. May raise origin traffic.",
  },
  tcp_swapfail: {
    title: "TCP_SWAPFAIL",
    meaning:
      "The object was in the cache but could not be accessed. The client did not receive the object.",
    opsHint: "Potential cache disk/corruption issue. Worth investigating if non-trivial volume.",
  },
  err_client_abort: {
    title: "ERR_CLIENT_ABORT",
    meaning: "The client disconnected before the complete object was sent.",
    opsHint: "Can be user/device/network aborts; watch spikes by client type/region.",
  },
  err_client_read_error: {
    title: "ERR_CLIENT_READ_ERROR",
    meaning: "The client had read errors (network problems).",
    opsHint: "Often last-mile/device connectivity issues.",
  },
  err_connect_fail: {
    title: "ERR_CONNECT_FAIL",
    meaning: "Traffic Server could not reach the origin server.",
    opsHint: "Origin unreachable (routing/firewall/outage). Check origin health + connectivity.",
  },
  err_dns_fail: {
    title: "ERR_DNS_FAIL",
    meaning:
      "The Domain Name Server (DNS) could not resolve the origin server name, or no DNS could be reached.",
    opsHint: "DNS outage/misconfig. Check resolvers, DNS latency, and origin hostname.",
  },
  err_invalid_req: {
    title: "ERR_INVALID_REQ",
    meaning:
      "The client HTTP request was invalid. (Traffic Server forwards requests with unknown methods to the origin server.)",
    opsHint: "Often malformed clients/bots. Check request samples and UA distribution.",
  },
  err_read_timeout: {
    title: "ERR_READ_TIMEOUT",
    meaning:
      "The origin server did not respond to Traffic Server’s request within the timeout interval.",
    opsHint: "Origin slow/unresponsive. Check origin latency, timeouts, and upstream saturation.",
  },
  err_proxy_denied: {
    title: "ERR_PROXY_DENIED",
    meaning: "Client service was denied.",
    opsHint: "ACL/auth/policy denial. Check rules, geo blocks, token/auth failures.",
  },
  err_unknown: {
    title: "ERR_UNKNOWN",
    meaning:
      "The client connected, but subsequently disconnected without sending a request.",
    opsHint: "Often connection churn/scans. Look at edge logs + connection metrics.",
  },
};

export function lookupAtsCrc(raw: string): GlossaryEntry | null {
  const k = String(raw || "").trim().toLowerCase();
  if (!k) return null;
  const key = k.replace(/\s+/g, "_");
  return ATS_CRC_GLOSSARY[key] || null;
}

export function isDefinitionQuestion(text: string) {
  const t = String(text || "").trim().toLowerCase();
  return (
    t.startsWith("what is ") ||
    t.startsWith("what’s ") ||
    t.startsWith("whats ") ||
    t.startsWith("define ") ||
    t.startsWith("meaning of ") ||
    t.startsWith("explain ")
  );
}

export function extractTermFromDefinitionQuestion(text: string) {
  const t = String(text || "").trim();
  const m =
    t.match(/^(what is|what’s|whats|define|meaning of|explain)\s+(.+)$/i) || [];
  const term = (m[2] || "").trim();
  return term.replace(/[?.!]+$/, "").trim();
}
