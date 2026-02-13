"use client";

import Image from "next/image";
import React, { useEffect, useState } from "react";

export default function DemoLoginPage() {
  const [nextPath, setNextPath] = useState("/");
  const [passcode, setPasscode] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ✅ Runs ONLY in browser, never during build
  useEffect(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      setNextPath(sp.get("next") || "/");
    }
  }, []);

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
    setErr((data as any)?.error || "Invalid passcode");
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
            <div style={styles.title}>Cachey</div>
            <div style={styles.subtitle}>Sign in to continue</div>
          </div>
        </div>

        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.label}>Passcode</label>

          <input
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Enter passcode"
            autoFocus
            type="password"
            style={styles.input}
          />

          {err && <div style={styles.error}>{err}</div>}

          <button
            type="submit"
            disabled={loading || !passcode}
            style={{
              ...styles.primaryBtn,
              opacity: loading || !passcode ? 0.7 : 1,
              cursor: loading || !passcode ? "not-allowed" : "pointer",
            }}
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

  title: { fontSize: 18, fontWeight: 750 },
  subtitle: { fontSize: 13, opacity: 0.6 },

  form: { paddingTop: 14 },

  label: {
    fontSize: 13,
    fontWeight: 600,
    opacity: 0.7,
  },

  input: {
    width: "100%",
    marginTop: 8,
    padding: "12px",
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.12)",
    fontSize: 15,
  },

  error: {
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    background: "rgba(239,68,68,0.08)",
    color: "#991b1b",
    fontSize: 13,
  },

  primaryBtn: {
    marginTop: 12,
    width: "100%",
    padding: "12px",
    borderRadius: 14,
    background: "#111827",
    color: "white",
    fontWeight: 700,
    border: "none",
  },

  small: {
    marginTop: 12,
    fontSize: 12,
    opacity: 0.55,
  },
};
