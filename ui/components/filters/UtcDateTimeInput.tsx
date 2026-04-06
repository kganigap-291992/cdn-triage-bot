"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type UtcDateTimeInputProps = {
  label: string;
  value: string;
  onChange: (next: string) => void;
};

function splitValue(value: string): {
  datePart: string;
  hourPart: string;
  minutePart: string;
} {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);

  if (!match) {
    return {
      datePart: "",
      hourPart: "00",
      minutePart: "00",
    };
  }

  return {
    datePart: match[1],
    hourPart: match[2],
    minutePart: match[3],
  };
}

function buildValue(datePart: string, hourPart: string, minutePart: string): string {
  if (!datePart) return "";
  return `${datePart}T${hourPart}:${minutePart}`;
}

function formatDisplay(value: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);

  if (!match) return "Select UTC time";

  const [, y, mo, d, hh, mm] = match;
  return `${y}-${mo}-${d} ${hh}:${mm} UTC`;
}

function nowUtcLocalLike(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${hh}:${mm}`;
}

export default function UtcDateTimeInput({
  label,
  value,
  onChange,
}: UtcDateTimeInputProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  const parsed = useMemo(() => splitValue(value), [value]);

  const [draftDate, setDraftDate] = useState(parsed.datePart);
  const [draftHour, setDraftHour] = useState(parsed.hourPart);
  const [draftMinute, setDraftMinute] = useState(parsed.minutePart);

  useEffect(() => {
    setDraftDate(parsed.datePart);
    setDraftHour(parsed.hourPart);
    setDraftMinute(parsed.minutePart);
  }, [parsed.datePart, parsed.hourPart, parsed.minutePart]);

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(event.target as Node)) return;
      setOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const hourOptions = useMemo(
    () => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")),
    []
  );

  const minuteOptions = useMemo(
    () => Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")),
    []
  );

  function commitNext(nextDate: string, nextHour: string, nextMinute: string) {
    const nextValue = buildValue(nextDate, nextHour, nextMinute);
    onChange(nextValue);
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="mb-1 text-[11px] text-gray-400">{label}</div>

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/10 px-3 py-2 text-left text-sm text-gray-100 outline-none transition hover:bg-white/15 focus:ring-2 focus:ring-blue-500/40"
      >
        <span className={value ? "text-gray-100" : "text-gray-500"}>
          {formatDisplay(value)}
        </span>
        <span className="ml-3 text-xs text-gray-400">UTC</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-[80] mt-2 w-full min-w-[320px] rounded-2xl border border-white/10 bg-[#0f141b] p-4 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[11px] text-gray-400">Date</div>
              <input
                type="text"
                inputMode="numeric"
                placeholder="YYYY-MM-DD"
                value={draftDate}
                onChange={(e) => {
                    const nextDate = e.target.value;

                    // basic guard (optional but recommended)
                    if (/^\d{0,4}(-\d{0,2}){0,2}$/.test(nextDate)) {
                    setDraftDate(nextDate);

                    // only commit when full date is valid
                    if (/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
                        commitNext(nextDate, draftHour, draftMinute);
                    }
                    }
                }}
                className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/40"
                />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[11px] text-gray-400">Hour</div>
                <select
                  value={draftHour}
                  onChange={(e) => {
                    const nextHour = e.target.value;
                    setDraftHour(nextHour);
                    commitNext(draftDate, nextHour, draftMinute);
                  }}
                  className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  {hourOptions.map((hh) => (
                    <option key={hh} value={hh} className="bg-[#0f141b]">
                      {hh}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 text-[11px] text-gray-400">Minute</div>
                <select
                  value={draftMinute}
                  onChange={(e) => {
                    const nextMinute = e.target.value;
                    setDraftMinute(nextMinute);
                    commitNext(draftDate, draftHour, nextMinute);
                  }}
                  className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/40"
                >
                  {minuteOptions.map((mm) => (
                    <option key={mm} value={mm} className="bg-[#0f141b]">
                      {mm}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-[11px] text-gray-500">
                Stored as UTC
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    setDraftDate("");
                    setDraftHour("00");
                    setDraftMinute("00");
                  }}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
                >
                  Clear
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const next = nowUtcLocalLike();
                    const parsedNow = splitValue(next);
                    setDraftDate(parsedNow.datePart);
                    setDraftHour(parsedNow.hourPart);
                    setDraftMinute(parsedNow.minutePart);
                    onChange(next);
                  }}
                  className="rounded-lg border border-blue-400/20 bg-blue-400/10 px-3 py-1.5 text-xs text-blue-200 hover:bg-blue-400/15"
                >
                  Now
                </button>

                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-white/10 bg-white/10 px-3 py-1.5 text-xs text-gray-100 hover:bg-white/15"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}