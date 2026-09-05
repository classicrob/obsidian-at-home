// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ThinkingTrailProvider,
  useThinkingTrail,
} from "./thinking-trails-app.js";
import type { CapturedThinkingTrail } from "./thinking-trails.js";

function TrailProbe() {
  const trail = useThinkingTrail()!;
  let activeVisit: string | null = null;
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          activeVisit = trail.beginVisit({
            label: "Child note",
            target: {
              kind: "workspace",
              environmentId: "env-1",
              path: "Child note.md",
            },
            relation: "link",
            previewMode: "note",
            parentLocalId: null,
          });
          trail.markLoaded(activeVisit);
        }}
      >
        Start
      </button>
      <button
        type="button"
        onClick={() => {
          if (activeVisit) trail.endVisit(activeVisit);
        }}
      >
        End
      </button>
      <button
        type="button"
        onClick={() => {
          if (!activeVisit) return;
          trail.interact(activeVisit, true);
          trail.finish("context-changed");
        }}
      >
        Click through
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("thinking trail capture", () => {
  it("ignores flyovers and records a deliberate hover after the exit grace period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const recorded: CapturedThinkingTrail[] = [];
    const view = render(
      <ThinkingTrailProvider
        threadId="thread-1"
        projectId="project-1"
        originKind="file"
        rootLabel="Root note"
        rootTarget={{
          kind: "workspace",
          environmentId: "env-1",
          path: "Root note.md",
        }}
        record={(trail) => recorded.push(trail)}
      >
        <TrailProbe />
      </ThinkingTrailProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(view.getByRole("button", { name: "End" }));
    act(() => vi.advanceTimersByTime(2_000));
    expect(recorded).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Start" }));
    act(() => vi.advanceTimersByTime(450));
    fireEvent.click(view.getByRole("button", { name: "End" }));
    act(() => vi.advanceTimersByTime(1_999));
    expect(recorded).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      threadId: "thread-1",
      finishReason: "hover-chain-exited",
    });
    expect(recorded[0]!.steps.map((step) => step.label)).toEqual([
      "Root note",
      "Child note",
    ]);
  });

  it("records click-through immediately without requiring hover dwell", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const recorded: CapturedThinkingTrail[] = [];
    const view = render(
      <ThinkingTrailProvider
        threadId="thread-1"
        projectId="project-1"
        originKind="file"
        rootLabel="Root note"
        rootTarget={null}
        record={(trail) => recorded.push(trail)}
      >
        <TrailProbe />
      </ThinkingTrailProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: "Start" }));
    fireEvent.click(view.getByRole("button", { name: "Click through" }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.steps[1]).toMatchObject({
      label: "Child note",
      clicked: true,
      interactionCount: 1,
    });
  });
});
