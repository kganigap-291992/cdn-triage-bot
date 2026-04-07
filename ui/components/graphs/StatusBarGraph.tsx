import React from "react";

type Props = {
  status: Record<string, number>;
};

const ORDER = [
  "200", "206", "304",
  "403", "404", "429",
  "500", "502", "503", "504",
];

export default function StatusBarGraph({ status }: Props) {
  if (!status) return null;

  const data = ORDER.map((code) => ({
    code,
    value: status[`status_${code}`] || 0,
  }));

  const max = Math.max(...data.map((d) => d.value));

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-400">Status Distribution</div>

      <div className="space-y-1">
        {data.map((d) => {
          if (!d.value) return null;

          const width = (d.value / max) * 100;

          return (
            <div key={d.code} className="flex items-center gap-2">
              <div className="w-10 text-xs text-gray-400">
                {d.code}
              </div>

              <div className="flex-1 bg-white/5 rounded h-2 relative">
                <div
                  className="bg-blue-400/70 h-2 rounded"
                  style={{ width: `${width}%` }}
                />
              </div>

              <div className="text-xs text-gray-300 w-16 text-right">
                {d.value.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}