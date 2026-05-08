// ui/app/notebook/components/NotebookUploadCard.tsx

type Props = {
  fileName?: string | null;
};

export default function NotebookUploadCard({
  fileName = null,
}: Props) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/30 p-6 backdrop-blur-sm">
      <div className="mb-6">
        <div className="text-xs uppercase tracking-[0.2em] text-blue-300/80">
          Cachey Notebook
        </div>

        <h1 className="mt-2 text-3xl font-semibold text-white">
          AI Onboarding Walkthrough Generator
        </h1>

        <div className="mt-2 inline-flex rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
          Internal AI Training + Onboarding Lab
        </div>

        <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-400">
          Upload technical PDFs and generate NotebookLM-style
          onboarding walkthrough videos with narrated engineering
          conversations, operational visuals, and downloadable MP4
          output.
        </p>
      </div>

      <div className="group relative rounded-2xl border border-dashed border-white/15 bg-white/[0.03] p-10 transition-all hover:border-blue-400/40 hover:bg-blue-500/[0.03]">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-2xl text-blue-300">
            ↑
          </div>

          <div className="text-lg font-medium text-white">
            Upload Technical PDF
          </div>

          <div className="mt-2 max-w-md text-sm leading-6 text-gray-400">
            Drag and drop onboarding PDFs, architecture diagrams,
            operational runbooks, or engineering documentation.
          </div>

          <button
            className="mt-6 rounded-xl border border-blue-500/30 bg-blue-500/10 px-5 py-2 text-sm font-medium text-blue-200 transition-all hover:bg-blue-500/20"
            type="button"
          >
            Choose PDF
          </button>

          <div className="mt-4 text-xs text-gray-500">
            PDF • Temporary processing • MP4 output
          </div>
        </div>
      </div>

      {fileName && (
        <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-300">
          Selected file: {fileName}
        </div>
      )}
    </div>
  );
}