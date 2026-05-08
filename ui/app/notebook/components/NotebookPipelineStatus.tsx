// ui/app/notebook/components/NotebookPipelineStatus.tsx

import type { NotebookPipelineStep } from "../lib/notebookTypes";

type Props = {
  steps: NotebookPipelineStep[];
};

function getStepIcon(status: NotebookPipelineStep["status"]) {
  switch (status) {
    case "complete":
      return "✓";

    case "active":
      return "⟳";

    case "error":
      return "✕";

    default:
      return "•";
  }
}

function getStepStyles(status: NotebookPipelineStep["status"]) {
  switch (status) {
    case "complete":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";

    case "active":
      return "border-blue-500/30 bg-blue-500/10 text-blue-300";

    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-300";

    default:
      return "border-white/10 bg-white/[0.03] text-gray-400";
  }
}

export default function NotebookPipelineStatus({ steps }: Props) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur-sm">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-blue-300/80">
            Notebook Pipeline
          </div>

          <h2 className="mt-1 text-lg font-semibold text-white">
            Walkthrough Generation Status
          </h2>
        </div>

        <div className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
      </div>

      <div className="space-y-3">
        {steps.map((step) => (
          <div
            key={step.id}
            className={`rounded-xl border p-4 transition-all ${getStepStyles(
              step.status
            )}`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-[2px] text-sm font-semibold">
                {getStepIcon(step.status)}
              </div>

              <div className="flex-1">
                <div className="text-sm font-medium">
                  {step.label}
                </div>

                <div className="mt-1 text-xs opacity-80">
                  {step.description}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}