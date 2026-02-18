import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

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
