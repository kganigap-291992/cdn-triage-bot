// ui/app/notebook/lib/pipelineSteps.ts

import type { NotebookPipelineStep } from "./notebookTypes";

export const NOTEBOOK_PIPELINE_STEPS: NotebookPipelineStep[] = [
  {
    id: "upload",
    label: "PDF uploaded",
    description: "Securely receiving the source document.",
    status: "pending",
  },
  {
    id: "extract",
    label: "Extracting document text",
    description: "Reading text, headings, and useful technical context.",
    status: "pending",
  },
  {
    id: "outline",
    label: "Building walkthrough outline",
    description: "Turning the document into an onboarding-friendly structure.",
    status: "pending",
  },
  {
    id: "dialogue",
    label: "Generating engineer dialogue",
    description: "Creating a two-person senior engineer and new joiner walkthrough.",
    status: "pending",
  },
  {
    id: "audio",
    label: "Generating narration audio",
    description: "Producing low-cost narrated audio using OpenAI TTS.",
    status: "pending",
  },
  {
    id: "render",
    label: "Rendering video",
    description: "Combining script, captions, audio, and visuals into an MP4.",
    status: "pending",
  },
  {
    id: "download",
    label: "Preparing download",
    description: "Finalizing the temporary MP4 download link.",
    status: "pending",
  },
];

export function getNotebookPipelineSteps(
  activeStepId: NotebookPipelineStep["id"] | null,
  completedStepIds: NotebookPipelineStep["id"][] = []
): NotebookPipelineStep[] {
  return NOTEBOOK_PIPELINE_STEPS.map((step) => {
    if (completedStepIds.includes(step.id)) {
      return { ...step, status: "complete" };
    }

    if (step.id === activeStepId) {
      return { ...step, status: "active" };
    }

    return step;
  });
}