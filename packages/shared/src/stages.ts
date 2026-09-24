/**
 * Default workflow stages for a deliverable. Workspaces can rename/reorder
 * these later (Stage 1 task management work), but every deliverable needs a
 * stage to sit in from day one, and reports key off `stageType`.
 */
export type StageType = "backlog" | "in_progress" | "internal_review" | "client_review" | "done";

export interface StageDefinition {
  key: string;
  label: string;
  stageType: StageType;
  order: number;
}

export const DEFAULT_STAGES: StageDefinition[] = [
  { key: "brief", label: "Brief", stageType: "backlog", order: 0 },
  { key: "production", label: "Production", stageType: "in_progress", order: 1 },
  { key: "internal_review", label: "Internal Review", stageType: "internal_review", order: 2 },
  { key: "client_review", label: "Client Review", stageType: "client_review", order: 3 },
  { key: "approved", label: "Approved", stageType: "done", order: 4 },
];
