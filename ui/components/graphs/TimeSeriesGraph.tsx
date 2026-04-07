import React from "react";

type Point = {
  ts: string;
  value: number;
};

type Props = {
  data: Point[];
  label?: string;
};

export default function TimeSeriesGraph({ data, label }: Props) {
  if (!data || data.length === 0) {
    return (
      <div className="text-xs text-gray-500">No graph data available</div>
    );
  }

  const max = Math.max(...data.map((d) => d.value));
  const min = Math.min(...data.map((d) => d.value));

  return (
    <div className="space-y-2">
      {label && (
        <div className="text-xs text-gray-400">{label}</div>
      )}

      <div className="flex items-end gap-1 h-24">
        {data.map((point, i) => {
          const normalized =
            max === min ? 50 : ((point.value - min) / (max - min)) * 100;

          return (
            <div
              key={i}
              className="flex-1 bg-blue-400/70 rounded-sm"
              style={{ height: `${normalized}%` }}
              title={`${point.ts} → ${point.value}`}
            />
          );
        })}
      </div>
    </div>
  );
}