import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

export async function GET() {
  const cwd = process.cwd();

  const candidates = [
    path.join(cwd, "app", "debug", "page.tsx"),
    path.join(cwd, "ui", "app", "debug", "page.tsx"),
    path.join(cwd, "src", "app", "debug", "page.tsx"),
  ];

  const exists = candidates.map((p) => ({
    path: p,
    exists: fs.existsSync(p),
  }));

  return NextResponse.json({
    cwd,
    exists,
    node: process.version,
  });
}
