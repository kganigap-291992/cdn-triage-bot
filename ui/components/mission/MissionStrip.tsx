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
  const locationBits = [
    args.partner,
    args.service,
    args.region && args.region !== "all" ? args.region : null,
    args.pop && args.pop !== "all" ? args.pop : null,
  ].filter(Boolean);

  const timeText =
    args.timeMode === "absolute" && args.startTsUtc && args.endTsUtc
      ? `${formatUtcYmdHm(args.startTsUtc)} → ${formatUtcYmdHm(args.endTsUtc)} UTC`
      : `last ${args.windowMinutes || 120}m`;

  return [...locationBits, timeText].filter(Boolean).join(" • ");
}

function getStatusMeta(status?: string) {
  switch (status) {
    case "ok":
      return {
        dot: "bg-emerald-400",
        label: "System Healthy",
        text: "text-emerald-200",
      };
    case "warn":
      return {
        dot: "bg-amber-400",
        label: "Degraded",
        text: "text-amber-200",
      };
    case "critical":
      return {
        dot: "bg-red-400",
        label: "Incident",
        text: "text-red-200",
      };
    default:
      return {
        dot: "bg-blue-400",
        label: "Investigation Active",
        text: "text-blue-200",
      };
  }
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

  const status = getStatusMeta(overallState);

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 shadow-lg shadow-black/10">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />
            <span className={`text-sm font-semibold ${status.text}`}>
              {status.label}
            </span>
          </div>

          <div className="mt-1 text-xs text-gray-400 break-words">
            {scopeText}
          </div>

          <div className="mt-1 text-[11px] text-gray-500">
            Chat will use this investigation scope unless you change it.
          </div>
        </div>

        {onChange && (
          <button
            type="button"
            onClick={onChange}
            className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-200 hover:bg-white/10"
          >
            Change
          </button>
        )}
      </div>
    </div>
  );
}