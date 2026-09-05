import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  thinkingTrailSignalScore,
  thinkingTrailTargetKey,
  type CapturedThinkingTrail,
  type CapturedThinkingTrailStep,
  type StoredThinkingTrail,
  type StoredThinkingTrailStep,
  type ThinkingTrailFinishReason,
  type ThinkingTrailTarget,
} from "./thinking-trails.js";

type TrailDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface TrailRow {
  id: number;
  thread_id: string | null;
  project_id: string | null;
  origin_kind: "file" | "chat";
  started_at_ms: number;
  ended_at_ms: number;
  duration_ms: number;
  finish_reason: ThinkingTrailFinishReason;
  signal_score: number;
  click_count: number;
  max_depth: number;
}

interface StepRow {
  trail_id: number;
  ordinal: number;
  parent_ordinal: number | null;
  depth: number;
  local_id: string;
  label: string;
  target_json: string | null;
  relation: "root" | "link" | "backlink";
  preview_mode: "note" | "backlinks";
  entered_at_ms: number;
  exited_at_ms: number;
  dwell_ms: number;
  interaction_count: number;
  clicked: number;
}

export const thinkingTrailMigrations = [
  `
    CREATE TABLE IF NOT EXISTS thinking_trails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      project_id TEXT,
      origin_kind TEXT NOT NULL CHECK (origin_kind IN ('file', 'chat')),
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      finish_reason TEXT NOT NULL,
      signal_score INTEGER NOT NULL,
      click_count INTEGER NOT NULL,
      max_depth INTEGER NOT NULL,
      last_clicked_target_key TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thinking_trail_steps (
      trail_id INTEGER NOT NULL REFERENCES thinking_trails(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      parent_ordinal INTEGER,
      depth INTEGER NOT NULL,
      local_id TEXT NOT NULL,
      label TEXT NOT NULL,
      target_key TEXT,
      target_json TEXT,
      relation TEXT NOT NULL CHECK (relation IN ('root', 'link', 'backlink')),
      preview_mode TEXT NOT NULL CHECK (preview_mode IN ('note', 'backlinks')),
      entered_at_ms INTEGER NOT NULL,
      exited_at_ms INTEGER NOT NULL,
      dwell_ms INTEGER NOT NULL,
      interaction_count INTEGER NOT NULL,
      clicked INTEGER NOT NULL CHECK (clicked IN (0, 1)),
      PRIMARY KEY (trail_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS thinking_trails_ended_idx
      ON thinking_trails(ended_at_ms DESC);
    CREATE INDEX IF NOT EXISTS thinking_trail_steps_target_idx
      ON thinking_trail_steps(target_key, trail_id);
  `,
];

function targetJson(target: ThinkingTrailTarget | null): string | null {
  return target ? JSON.stringify(target) : null;
}

function parseTarget(value: string | null): ThinkingTrailTarget | null {
  return value ? (JSON.parse(value) as ThinkingTrailTarget) : null;
}

function stepDepths(steps: readonly CapturedThinkingTrailStep[]) {
  const depths = new Map<string, number>();
  for (const step of steps) {
    depths.set(
      step.localId,
      step.parentLocalId === null
        ? 0
        : (depths.get(step.parentLocalId) ?? 0) + 1,
    );
  }
  return depths;
}

function continuationCandidate(
  db: TrailDatabase,
  trail: CapturedThinkingTrail,
): { id: number; clickedOrdinal: number; clickedDepth: number } | null {
  const rootKey = thinkingTrailTargetKey(trail.steps[0]?.target ?? null);
  if (!rootKey) return null;
  return (
    db
      .prepare(
        `SELECT t.id, s.ordinal AS clickedOrdinal, s.depth AS clickedDepth
         FROM thinking_trails t
         JOIN thinking_trail_steps s ON s.trail_id = t.id
         WHERE ((? IS NOT NULL AND t.thread_id = ?)
                OR (? IS NULL AND t.project_id IS ?))
           AND t.ended_at_ms BETWEEN ? AND ?
           AND t.last_clicked_target_key = ?
           AND s.clicked = 1
           AND s.target_key = ?
         ORDER BY t.ended_at_ms DESC, s.ordinal DESC
         LIMIT 1`,
      )
      .get(
        trail.threadId,
        trail.threadId,
        trail.threadId,
        trail.projectId,
        trail.startedAtMs - 10_000,
        trail.startedAtMs,
        rootKey,
        rootKey,
      ) as
        | { id: number; clickedOrdinal: number; clickedDepth: number }
        | undefined
  ) ?? null;
}

function insertSteps(
  db: TrailDatabase,
  trailId: number,
  steps: readonly CapturedThinkingTrailStep[],
  startingOrdinal: number,
  rootParentOrdinal: number | null,
  depthOffset: number,
) {
  const insert = db.prepare(
    `INSERT INTO thinking_trail_steps (
      trail_id, ordinal, parent_ordinal, depth, local_id, label,
      target_key, target_json, relation, preview_mode, entered_at_ms,
      exited_at_ms, dwell_ms, interaction_count, clicked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const depths = stepDepths(steps);
  const ordinals = new Map<string, number>();
  steps.forEach((step, index) => {
    const ordinal = startingOrdinal + index;
    ordinals.set(step.localId, ordinal);
    const parentOrdinal =
      step.parentLocalId === null
        ? rootParentOrdinal
        : (ordinals.get(step.parentLocalId) ?? rootParentOrdinal);
    const depth = (depths.get(step.localId) ?? 0) + depthOffset;
    insert.run(
      trailId,
      ordinal,
      parentOrdinal,
      depth,
      step.localId,
      step.label,
      thinkingTrailTargetKey(step.target),
      targetJson(step.target),
      step.relation,
      step.previewMode,
      step.enteredAtMs,
      step.exitedAtMs,
      step.dwellMs,
      step.interactionCount,
      step.clicked ? 1 : 0,
    );
  });
}

function refreshTrailSummary(db: TrailDatabase, trailId: number, endedAtMs: number, reason: ThinkingTrailFinishReason) {
  const startedAtMs = (
    db.prepare("SELECT started_at_ms FROM thinking_trails WHERE id = ?").get(trailId) as {
      started_at_ms: number;
    }
  ).started_at_ms;
  const steps = db
    .prepare(
      `SELECT clicked, dwell_ms AS dwellMs, interaction_count AS interactionCount,
              relation
       FROM thinking_trail_steps WHERE trail_id = ?`,
    )
    .all(trailId) as Array<{
    clicked: number;
    dwellMs: number;
    interactionCount: number;
    relation: "root" | "link" | "backlink";
  }>;
  const lastClicked = db
    .prepare(
      `SELECT target_key FROM thinking_trail_steps
       WHERE trail_id = ? AND clicked = 1
       ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(trailId) as { target_key: string | null } | undefined;
  const maxDepth = (
    db.prepare("SELECT COALESCE(MAX(depth), 0) AS value FROM thinking_trail_steps WHERE trail_id = ?").get(trailId) as {
      value: number;
    }
  ).value;
  db.prepare(
    `UPDATE thinking_trails
     SET ended_at_ms = ?, duration_ms = ?, finish_reason = ?,
         signal_score = ?, click_count = ?, max_depth = ?,
         last_clicked_target_key = ?
     WHERE id = ?`,
  ).run(
    endedAtMs,
    Math.max(0, endedAtMs - startedAtMs),
    reason,
    thinkingTrailSignalScore(
      steps.map((step) => ({ ...step, clicked: step.clicked === 1 })),
    ),
    steps.filter((step) => step.clicked === 1).length,
    maxDepth,
    lastClicked?.target_key ?? null,
    trailId,
  );
}

export function recordThinkingTrail(
  db: TrailDatabase,
  trail: CapturedThinkingTrail,
): number {
  return db.transaction(() => {
    const continuation = continuationCandidate(db, trail);
    if (continuation) {
      const maximum = db
        .prepare("SELECT MAX(ordinal) AS value FROM thinking_trail_steps WHERE trail_id = ?")
        .get(continuation.id) as { value: number };
      insertSteps(
        db,
        continuation.id,
        trail.steps.slice(1),
        maximum.value + 1,
        continuation.clickedOrdinal,
        continuation.clickedDepth,
      );
      db.prepare(
        "UPDATE thinking_trails SET project_id = COALESCE(project_id, ?) WHERE id = ?",
      ).run(trail.projectId, continuation.id);
      refreshTrailSummary(db, continuation.id, trail.endedAtMs, trail.finishReason);
      return continuation.id;
    }

    const created = db
      .prepare(
        `INSERT INTO thinking_trails (
          thread_id, project_id, origin_kind, started_at_ms, ended_at_ms,
          duration_ms, finish_reason, signal_score, click_count, max_depth,
          last_clicked_target_key, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?)`,
      )
      .run(
        trail.threadId,
        trail.projectId,
        trail.originKind,
        trail.startedAtMs,
        trail.endedAtMs,
        Math.max(0, trail.endedAtMs - trail.startedAtMs),
        trail.finishReason,
        Date.now(),
      );
    const trailId = Number(created.lastInsertRowid);
    insertSteps(db, trailId, trail.steps, 0, null, 0);
    refreshTrailSummary(db, trailId, trail.endedAtMs, trail.finishReason);
    return trailId;
  })();
}

function hydrateTrail(db: TrailDatabase, row: TrailRow): StoredThinkingTrail {
  const stepRows = db
    .prepare(
      `SELECT trail_id, ordinal, parent_ordinal, depth, local_id, label,
              target_json, relation, preview_mode, entered_at_ms, exited_at_ms,
              dwell_ms, interaction_count, clicked
       FROM thinking_trail_steps WHERE trail_id = ? ORDER BY ordinal`,
    )
    .all(row.id) as StepRow[];
  const steps: StoredThinkingTrailStep[] = stepRows.map((step) => ({
    localId: step.local_id,
    parentLocalId: null,
    ordinal: step.ordinal,
    parentOrdinal: step.parent_ordinal,
    depth: step.depth,
    label: step.label,
    target: parseTarget(step.target_json),
    relation: step.relation,
    previewMode: step.preview_mode,
    enteredAtMs: step.entered_at_ms,
    exitedAtMs: step.exited_at_ms,
    dwellMs: step.dwell_ms,
    interactionCount: step.interaction_count,
    clicked: step.clicked === 1,
  }));
  return {
    id: row.id,
    threadId: row.thread_id,
    projectId: row.project_id,
    originKind: row.origin_kind,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    durationMs: row.duration_ms,
    finishReason: row.finish_reason,
    signalScore: row.signal_score,
    clickCount: row.click_count,
    maxDepth: row.max_depth,
    steps,
  };
}

export function listThinkingTrails(
  db: TrailDatabase,
  options: { threadId?: string | null; note?: string; limit: number },
): StoredThinkingTrail[] {
  const filters: string[] = [];
  const values: unknown[] = [];
  if (options.threadId) {
    filters.push("t.thread_id = ?");
    values.push(options.threadId);
  }
  if (options.note?.trim()) {
    filters.push(
      `EXISTS (
        SELECT 1 FROM thinking_trail_steps s
        WHERE s.trail_id = t.id
          AND (LOWER(s.label) LIKE ? OR LOWER(COALESCE(s.target_key, '')) LIKE ?)
      )`,
    );
    const query = `%${options.note.trim().toLocaleLowerCase()}%`;
    values.push(query, query);
  }
  values.push(Math.max(1, Math.min(50, options.limit)));
  const rows = db
    .prepare(
      `SELECT id, thread_id, project_id, origin_kind, started_at_ms,
              ended_at_ms, duration_ms, finish_reason, signal_score,
              click_count, max_depth
       FROM thinking_trails t
       ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY ended_at_ms DESC
       LIMIT ?`,
    )
    .all(...values) as TrailRow[];
  return rows.map((row) => hydrateTrail(db, row));
}

export function formatThinkingTrails(trails: readonly StoredThinkingTrail[]): string {
  if (trails.length === 0) return "No thinking trails found.";
  return trails
    .map((trail) => {
      const children = new Map<number | null, StoredThinkingTrailStep[]>();
      for (const step of trail.steps) {
        const entries = children.get(step.parentOrdinal) ?? [];
        entries.push(step);
        children.set(step.parentOrdinal, entries);
      }
      const lines = [
        `Trail ${trail.id} — ${new Date(trail.startedAtMs).toISOString()} — ${Math.round(trail.durationMs / 1000)}s — signal ${trail.signalScore}/100`,
      ];
      const append = (parent: number | null, indent: number) => {
        for (const step of children.get(parent) ?? []) {
          const detail = [
            step.clicked ? "clicked" : null,
            step.previewMode === "backlinks" ? "contextual backlinks" : null,
            step.dwellMs > 0 ? `${(step.dwellMs / 1000).toFixed(1)}s` : null,
          ].filter(Boolean);
          lines.push(`${"  ".repeat(indent)}- ${step.label}${detail.length ? ` (${detail.join(", ")})` : ""}`);
          append(step.ordinal, indent + 1);
        }
      };
      append(null, 0);
      return lines.join("\n");
    })
    .join("\n\n");
}
