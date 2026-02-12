"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function DemoLoginPage() {
  const sp = useSearchParams();
  const nextPath = useMemo(() => sp.get("next") || "/", [sp]);

  const [passcode, setPasscode] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    const res = await fetch("/api/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });

    setLoading(false);

    if (res.ok) {
      window.location.href = nextPath;
      return;
    }

    const data = await res.json().catch(() => ({}));
    setErr(data?.error || "Invalid passcode");
  }

  async function logout() {
    await fetch("/api/demo-logout", { method: "POST" }).catch(() => {});
    window.location.href = "/demo";
  }

  return (
    <main style={styles.bg}>
      <div style={styles.card}>
        <div style={styles.header}>
          <Image
            src="/cachey-logo.png"
            alt="Cachey"
            width={44}
            height={44}
            priority
            style={{ borderRadius: 12 }}
          />
          <div>
            <div style={styles.title}>Cachey Demo</div>
            <div style={styles.subtitle}>Enter passcode to continue</div>
          </div>

          <button onClick={logout} style={styles.ghostBtn} type="button">
            Logout
          </button>
        </div>

        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.label}>Demo passcode</label>
          <input
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Enter passcode"
            autoFocus
            style={styles.input}
            type="password"
          />

          {err && <div style={styles.error}>{err}</div>}

          <button
            disabled={loading || !passcode}
            style={styles.primaryBtn}
            type="submit"
          >
            {loading ? "Checking…" : "Continue →"}
          </button>

          <div style={styles.small}>
            Tip: tunnel URL can change — this passcode gate still works.
          </div>
        </form>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bg: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 20,
    background: "linear-gradient(180deg, #fafafa, #f3f4f6)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: "#111827",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    background: "rgba(255,255,255,0.86)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
    border: "1px solid rgba(0,0,0,0.08)",
    borderRadius: 22,
    boxShadow: "0 18px 60px rgba(0,0,0,0.10)",
    padding: 18,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    paddingBottom: 14,
    borderBottom: "1px solid rgba(0,0,0,0.06)",
  },
  title: { fontSize: 18, fontWeight: 750, letterSpacing: -0.2 },
  subtitle: { marginTop: 2, fontSize: 13, color: "rgba(17,24,39,0.62)" },
  ghostBtn: {
    marginLeft: "auto",
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(17,24,39,0.12)",
    background: "rgba(255,255,255,0.7)",
    cursor: "pointer",
    fontWeight: 650,
    color: "#111827",
  },
  form: { paddingTop: 14 },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 650,
    color: "rgba(17,24,39,0.70)",
  },
  input: {
    width: "100%",
    marginTop: 8,
    padding: "12px 12px",
    borderRadius: 14,
    border: "1px solid rgba(17,24,39,0.12)",
    outline: "none",
    fontSize: 15,
    background: "white",
  },
  error: {
    marginTop: 10,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(239,68,68,0.25)",
    background: "rgba(239,68,68,0.07)",
    color: "#991b1b",
    fontSize: 13,
  },
  primaryBtn: {
    marginTop: 12,
    width: "100%",
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.10)",
    background: "#111827",
    color: "white",
    fontWeight: 750,
    cursor: "pointer",
    fontSize: 14.5,
  },
  small: { marginTop: 12, fontSize: 12.5, color: "rgba(17,24,39,0.55)" },
};
