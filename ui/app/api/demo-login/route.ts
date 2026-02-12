import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { passcode } = await req.json().catch(() => ({ passcode: "" }));

  if (!process.env.DEMO_PASSCODE) {
    return NextResponse.json(
      { error: "DEMO_PASSCODE not set on server" },
      { status: 500 }
    );
  }

  if (String(passcode || "") !== process.env.DEMO_PASSCODE) {
    return NextResponse.json({ error: "Invalid passcode" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  // Cookie for demo auth
  res.cookies.set("cachey_demo", "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // local+tunnel is HTTPS outside but localhost is http; keep false for dev
    path: "/",
    maxAge: 60 * 60 * 8, // 8 hours
  });
  return res;
}
