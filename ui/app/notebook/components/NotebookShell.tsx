// ui/app/notebook/components/NotebookShell.tsx

import NotebookPipelineStatus from "./NotebookPipelineStatus";
import NotebookUploadCard from "./NotebookUploadCard";

import { getNotebookPipelineSteps } from "../lib/pipelineSteps";

export default function NotebookShell() {
  const steps = getNotebookPipelineSteps("dialogue", [
    "upload",
    "extract",
    "outline",
  ]);

  return (
    <div className="min-h-screen bg-[#071019] text-white">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-6 py-8">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-blue-500/[0.08] via-black/40 to-cyan-500/[0.05] p-8 shadow-2xl shadow-black/30">
          <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1.2fr_0.8fr]">
            <NotebookUploadCard />

            <NotebookPipelineStatus steps={steps} />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-[0.2em] text-blue-300/80">
              Narration Engine
            </div>

            <div className="mt-3 text-lg font-semibold text-white">
              Two-Person Engineering Dialogue
            </div>

            <p className="mt-2 text-sm leading-6 text-gray-400">
              Generates NotebookLM-style onboarding conversations
              between a senior engineer and a new joiner using
              deterministic walkthrough planning.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-[0.2em] text-blue-300/80">
              Rendering Pipeline
            </div>

            <div className="mt-3 text-lg font-semibold text-white">
              OpenAI TTS + Remotion
            </div>

            <p className="mt-2 text-sm leading-6 text-gray-400">
              Produces narrated onboarding MP4 videos with lightweight,
              operationally clean infrastructure and temporary storage.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur-sm">
            <div className="text-xs uppercase tracking-[0.2em] text-blue-300/80">
              Infrastructure
            </div>

            <div className="mt-3 text-lg font-semibold text-white">
              Separate Worker Architecture
            </div>

            <p className="mt-2 text-sm leading-6 text-gray-400">
              Notebook rendering runs in an isolated worker container
              outside the Cachey operational triage stack.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}