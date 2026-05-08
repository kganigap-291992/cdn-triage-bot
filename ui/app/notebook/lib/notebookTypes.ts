// ui/app/notebook/lib/notebookTypes.ts

export type NotebookPipelineStepStatus =
  | "pending"
  | "active"
  | "complete"
  | "error";

export type NotebookPipelineStepId =
  | "upload"
  | "extract"
  | "outline"
  | "dialogue"
  | "audio"
  | "render"
  | "download";

export type NotebookPipelineStep = {
  id: NotebookPipelineStepId;
  label: string;
  description: string;
  status: NotebookPipelineStepStatus;
};

export type NotebookJobStatus =
  | "idle"
  | "uploading"
  | "processing"
  | "complete"
  | "error";

export type NotebookJob = {
  jobId: string | null;
  fileName: string | null;
  status: NotebookJobStatus;
  currentStepId: NotebookPipelineStepId | null;
  downloadUrl: string | null;
  errorMessage: string | null;
};

export type NotebookUploadState = {
  selectedFile: File | null;
  isDragging: boolean;
};