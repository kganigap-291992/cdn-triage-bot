import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ALLOW_EXACT = new Set([
  "/demo",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/cachey-logo.png",
]);

const ALLOW_PREFIX = [
  "/_next", // allow Next internals not covered by matcher (e.g. _next/data)

  // (Optional legacy/demo endpoints — harmless to keep explicit even though /api/* is allowed)
  "/api/demo-login",
  "/api/demo-logout",

  // public endpoints for UI + curl (also covered by /api/*, but fine to document intent)
  "/api/schema",
  "/api/triage",
  "/api/chat",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ✅ Always allow ALL API routes (otherwise curl + UI fetches can redirect to /demo)
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Allow exact matches
  if (ALLOW_EXACT.has(pathname)) return NextResponse.next();

  // Allow prefix matches
  if (ALLOW_PREFIX.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Everything else requires demo cookie (UI pages only)
  const authed = req.cookies.get("cachey_demo")?.value === "1";
  if (authed) return NextResponse.next();

  // Not authed → redirect to /demo
  const url = req.nextUrl.clone();
  url.pathname = "/demo";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};