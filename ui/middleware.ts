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
  "/api/demo-login",
  "/api/demo-logout",

  // ✅ public endpoints for UI + curl
  "/api/schema",
  "/api/triage",
  "/api/chat",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

<<<<<<< HEAD
  // Allow exact matches
  if (ALLOW_EXACT.has(pathname)) return NextResponse.next();

  // Allow prefix matches
  if (ALLOW_PREFIX.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Everything else requires demo cookie
=======
  // ✅ Always allow ALL API routes (otherwise curl + UI fetches redirect to /demo)
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Allow the demo login page
  if (pathname === "/demo") {
    return NextResponse.next();
  }

  // Allow Next internals + common static assets
  if (
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/cachey-logo.png"
  ) {
    return NextResponse.next();
  }

  // Check demo cookie (UI pages only)
>>>>>>> origin/main
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