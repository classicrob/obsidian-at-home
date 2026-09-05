export type ThinkingTrailTarget =
  | { kind: "workspace"; environmentId: string; path: string }
  | { kind: "host"; hostId: string; path: string }
  | { kind: "thread-storage"; threadId: string; path: string };

export type ThinkingTrailFinishReason =
  | "hover-chain-exited"
  | "context-changed"
  | "inactive"
  | "page-hidden";

export interface CapturedThinkingTrailStep {
  localId: string;
  parentLocalId: string | null;
  label: string;
  target: ThinkingTrailTarget | null;
  relation: "root" | "link" | "backlink";
  previewMode: "note" | "backlinks";
  enteredAtMs: number;
  exitedAtMs: number;
  dwellMs: number;
  interactionCount: number;
  clicked: boolean;
}

export interface CapturedThinkingTrail {
  threadId: string | null;
  projectId: string | null;
  originKind: "file" | "chat";
  startedAtMs: number;
  endedAtMs: number;
  finishReason: ThinkingTrailFinishReason;
  steps: CapturedThinkingTrailStep[];
}

export interface StoredThinkingTrailStep extends CapturedThinkingTrailStep {
  ordinal: number;
  parentOrdinal: number | null;
  depth: number;
}

export interface StoredThinkingTrail {
  id: number;
  threadId: string | null;
  projectId: string | null;
  originKind: "file" | "chat";
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  finishReason: ThinkingTrailFinishReason;
  signalScore: number;
  clickCount: number;
  maxDepth: number;
  steps: StoredThinkingTrailStep[];
}

export function thinkingTrailTargetKey(
  target: ThinkingTrailTarget | null,
): string | null {
  if (!target) return null;
  if (target.kind === "workspace") {
    return `workspace:${target.environmentId}:${target.path}`;
  }
  if (target.kind === "host") return `host:${target.hostId}:${target.path}`;
  return `thread-storage:${target.threadId}:${target.path}`;
}

export function thinkingTrailSignalScore(
  steps: readonly Pick<
    CapturedThinkingTrailStep,
    "clicked" | "dwellMs" | "interactionCount" | "relation"
  >[],
): number {
  const explored = steps.filter((step) => step.relation !== "root");
  const clicks = explored.filter((step) => step.clicked).length;
  const dwellSeconds = explored.reduce(
    (total, step) => total + Math.min(step.dwellMs, 30_000) / 1_000,
    0,
  );
  const interactions = explored.reduce(
    (total, step) => total + step.interactionCount,
    0,
  );
  return Math.round(
    Math.min(
      100,
      explored.length * 8 +
        Math.min(25, dwellSeconds * 1.5) +
        Math.min(15, interactions * 3) +
        clicks * 30,
    ),
  );
}
