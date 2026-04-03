type Props = {
  partner?: string;
  service?: string;
  region?: string;
  pop?: string;
  windowMinutes?: number;
  timeMode?: "relative" | "absolute";
  startTsUtc?: string | null;
  endTsUtc?: string | null;
  overallState?: string;
  primarySignal?: string;
  onChange?: () => void;
};

function formatUtcYmdHm(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}

function buildScopeText(args: {
  partner?: string;
  service?: string;
  region?: string;
  pop?: string;
  windowMinutes?: number;
  timeMode?: "relative" | "absolute";
  startTsUtc?: string | null;
  endTsUtc?: string | null;
}) {
  const {
    partner,
    service,
    region,
    pop,
    windowMinutes,
    timeMode,
    startTsUtc,
    endTsUtc,
  } = args;

  const base = [partner, service].filter(Boolean).join(" • ");

  const locationBits = [
    region && region !== "all" ? region : null,
    pop && pop !== "all" ? pop : null,
  ].filter(Boolean);

  const timeText =
    timeMode === "absolute" && startTsUtc && endTsUtc
      ? `${formatUtcYmdHm(startTsUtc)} → ${formatUtcYmdHm(endTsUtc)} UTC`
      : `last ${windowMinutes || 120}m`;

  return [base, ...locationBits, timeText].filter(Boolean).join(" • ");
}

export default function MissionStrip({
  partner,
  service,
  region,
  pop,
  windowMinutes,
  timeMode = "relative",
  startTsUtc,
  endTsUtc,
  overallState,
  primarySignal,
  onChange,
}: Props) {
  if (!partner || !service) return null;

  const scopeText = buildScopeText({
    partner,
    service,
    region,
    pop,
    windowMinutes,
    timeMode,
    startTsUtc,
    endTsUtc,
  });

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 flex items-start justify-between gap-4">
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400">Current scope:</span>
          <span className="text-sm font-semibold text-gray-200 break-words">
            {scopeText}
          </span>
          {onChange && (
            <button
              type="button"
              onClick={onChange}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-200 hover:bg-white/10"
            >
              Change
            </button>
          )}
        </div>
        <div className="mt-1 text-xs text-gray-400">
          Chat will use this scope unless you change it.
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
        {overallState && (
          <span className="text-xs px-2 py-1 rounded-full bg-white/10 text-gray-200">
            {overallState}
          </span>
        )}

        {primarySignal && (
          <span className="text-xs px-2 py-1 rounded-full bg-blue-500/20 text-blue-300">
            {primarySignal}
          </span>
        )}
      </div>
    </div>
  );
}