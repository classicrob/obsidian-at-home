import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  CapturedThinkingTrail,
  CapturedThinkingTrailStep,
  ThinkingTrailFinishReason,
  ThinkingTrailTarget,
} from "./thinking-trails.js";

const QUALIFY_AFTER_MS = 450;
const FINISH_AFTER_EXIT_MS = 2_000;
const INACTIVITY_MS = 90_000;

interface TrailVisitInput {
  label: string;
  target: ThinkingTrailTarget;
  relation: "link" | "backlink";
  previewMode: "note" | "backlinks";
  parentLocalId: string | null;
}

interface TrailCapture {
  beginVisit(input: TrailVisitInput): string;
  markLoaded(localId: string): void;
  interact(localId: string, clicked?: boolean): void;
  endVisit(localId: string): void;
  finish(reason: ThinkingTrailFinishReason): void;
}

interface MutableTrailStep extends CapturedThinkingTrailStep {
  qualified: boolean;
  loadedAtMs: number | null;
  qualificationTimer: number | null;
}

const TrailCaptureContext = createContext<TrailCapture | null>(null);
const TrailParentContext = createContext<string | null>(null);

export function useThinkingTrail() {
  return useContext(TrailCaptureContext);
}

export function useThinkingTrailParent() {
  return useContext(TrailParentContext);
}

export function ThinkingTrailParent({
  localId,
  children,
}: {
  localId: string | null;
  children: ReactNode;
}) {
  return (
    <TrailParentContext.Provider value={localId}>
      {children}
    </TrailParentContext.Provider>
  );
}

export function ThinkingTrailProvider({
  threadId,
  projectId,
  originKind,
  rootLabel,
  rootTarget,
  record,
  children,
}: {
  threadId: string | null;
  projectId: string | null;
  originKind: "file" | "chat";
  rootLabel: string;
  rootTarget: ThinkingTrailTarget | null;
  record(trail: CapturedThinkingTrail): void;
  children: ReactNode;
}) {
  const sequence = useRef(0);
  const startedAtMs = useRef<number | null>(null);
  const steps = useRef(new Map<string, MutableTrailStep>());
  const activeVisits = useRef(new Set<string>());
  const finishTimer = useRef<number | null>(null);
  const inactivityTimer = useRef<number | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;

  const clearFinishTimer = useCallback(() => {
    if (finishTimer.current !== null) window.clearTimeout(finishTimer.current);
    finishTimer.current = null;
  }, []);

  const clearInactivityTimer = useCallback(() => {
    if (inactivityTimer.current !== null) {
      window.clearTimeout(inactivityTimer.current);
    }
    inactivityTimer.current = null;
  }, []);

  const reset = useCallback(() => {
    clearFinishTimer();
    clearInactivityTimer();
    for (const step of steps.current.values()) {
      if (step.qualificationTimer !== null) {
        window.clearTimeout(step.qualificationTimer);
      }
    }
    steps.current.clear();
    activeVisits.current.clear();
    startedAtMs.current = null;
  }, [clearFinishTimer, clearInactivityTimer]);

  const qualify = useCallback((localId: string) => {
    const step = steps.current.get(localId);
    if (!step || step.qualified) return;
    step.qualified = true;
    if (step.parentLocalId) qualify(step.parentLocalId);
  }, []);

  const finish = useCallback(
    (reason: ThinkingTrailFinishReason) => {
      const started = startedAtMs.current;
      if (started === null) return;
      const ended = Date.now();
      for (const localId of activeVisits.current) {
        const step = steps.current.get(localId);
        if (!step) continue;
        step.exitedAtMs = ended;
        step.dwellMs = Math.max(
          step.dwellMs,
          ended - (step.loadedAtMs ?? step.enteredAtMs),
        );
      }
      const captured = [...steps.current.values()]
        .filter((step) => step.qualified)
        .map(
          ({ qualified: _qualified, loadedAtMs: _loadedAtMs, qualificationTimer: _timer, ...step }) =>
            step,
        );
      const explored = captured.filter((step) => step.relation !== "root");
      if (explored.length > 0) {
        recordRef.current({
          threadId,
          projectId,
          originKind,
          startedAtMs: started,
          endedAtMs: ended,
          finishReason: reason,
          steps: captured,
        });
      }
      reset();
    },
    [originKind, projectId, reset, threadId],
  );

  const touchInactivity = useCallback(() => {
    clearInactivityTimer();
    inactivityTimer.current = window.setTimeout(
      () => finish("inactive"),
      INACTIVITY_MS,
    );
  }, [clearInactivityTimer, finish]);

  const ensureRoot = useCallback(
    (now: number) => {
      if (startedAtMs.current !== null) return [...steps.current.keys()][0]!;
      startedAtMs.current = now;
      const rootId = `root-${++sequence.current}`;
      steps.current.set(rootId, {
        localId: rootId,
        parentLocalId: null,
        label: rootLabel,
        target: rootTarget,
        relation: "root",
        previewMode: "note",
        enteredAtMs: now,
        exitedAtMs: now,
        dwellMs: 0,
        interactionCount: 0,
        clicked: false,
        qualified: true,
        loadedAtMs: now,
        qualificationTimer: null,
      });
      return rootId;
    },
    [rootLabel, rootTarget],
  );

  const capture = useMemo<TrailCapture>(
    () => ({
      beginVisit(input) {
        const now = Date.now();
        clearFinishTimer();
        const rootId = ensureRoot(now);
        const localId = `visit-${++sequence.current}`;
        const parentLocalId = input.parentLocalId ?? rootId;
        steps.current.set(localId, {
          localId,
          parentLocalId,
          label: input.label,
          target: input.target,
          relation: input.relation,
          previewMode: input.previewMode,
          enteredAtMs: now,
          exitedAtMs: now,
          dwellMs: 0,
          interactionCount: 0,
          clicked: false,
          qualified: false,
          loadedAtMs: null,
          qualificationTimer: null,
        });
        activeVisits.current.add(localId);
        if (input.parentLocalId) qualify(input.parentLocalId);
        touchInactivity();
        return localId;
      },
      markLoaded(localId) {
        const step = steps.current.get(localId);
        if (!step || step.loadedAtMs !== null) return;
        step.loadedAtMs = Date.now();
        step.qualificationTimer = window.setTimeout(() => {
          step.qualificationTimer = null;
          qualify(localId);
        }, QUALIFY_AFTER_MS);
      },
      interact(localId, clicked = false) {
        const step = steps.current.get(localId);
        if (!step) return;
        step.interactionCount += 1;
        step.clicked ||= clicked;
        qualify(localId);
        touchInactivity();
      },
      endVisit(localId) {
        const step = steps.current.get(localId);
        if (!step) return;
        const now = Date.now();
        step.exitedAtMs = now;
        step.dwellMs = Math.max(
          0,
          now - (step.loadedAtMs ?? step.enteredAtMs),
        );
        if (step.qualificationTimer !== null) {
          window.clearTimeout(step.qualificationTimer);
          step.qualificationTimer = null;
        }
        activeVisits.current.delete(localId);
        if (activeVisits.current.size === 0) {
          clearFinishTimer();
          finishTimer.current = window.setTimeout(
            () => finish("hover-chain-exited"),
            FINISH_AFTER_EXIT_MS,
          );
        }
      },
      finish,
    }),
    [clearFinishTimer, ensureRoot, finish, qualify, touchInactivity],
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") finish("page-hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      finish("context-changed");
      reset();
    };
  }, [finish, reset]);

  return (
    <TrailCaptureContext.Provider value={capture}>
      <TrailParentContext.Provider value={null}>
        {children}
      </TrailParentContext.Provider>
    </TrailCaptureContext.Provider>
  );
}
