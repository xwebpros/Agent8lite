import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above this import, so the panel sees the minimal hook runtime.
import RecordArchivePanel, { RecordArchiveView } from "../../apps/web/components/record-archive-panel";

// A minimal hook runtime: the panel is called as a plain function so its effects run without a DOM.
const hooks = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as { deps: unknown[] | undefined; run: () => void | (() => void) }[],
    previous: [] as (unknown[] | undefined)[],
    rerender: () => {},
  };
  return state;
});
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useRef<T>(initial: T) {
      const slot = hooks.index++;
      if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
      return hooks.slots[slot] as { current: T };
    },
    useState<T>(initial: T) {
      const slot = hooks.index++;
      if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
      const set = (value: T) => {
        hooks.slots[slot] = value;
        hooks.rerender();
      };
      return [hooks.slots[slot] as T, set] as const;
    },
    useEffect(run: () => void | (() => void), deps?: unknown[]) {
      hooks.effects.push({ deps, run });
    },
  };
});

type PanelProps = Parameters<typeof RecordArchivePanel>[0];
type ViewProps = Parameters<typeof RecordArchiveView>[0];

function mount(props: PanelProps) {
  let element!: ReactElement<ViewProps>;
  const render = () => {
    hooks.index = 0;
    hooks.effects = [];
    element = RecordArchivePanel(props) as ReactElement<ViewProps>;
    // Run effects whose dependencies changed, like React does after commit.
    hooks.effects.forEach((effect, position) => {
      const before = hooks.previous[position];
      const changed =
        !before || !effect.deps || effect.deps.some((value, at) => !Object.is(value, before[at]));
      hooks.previous[position] = effect.deps;
      if (changed) effect.run();
    });
  };
  hooks.rerender = render;
  render();
  return { view: () => element.props };
}

const base = (): PanelProps => ({
  kind: "contact",
  resourceId: "af000000-0000-4000-8000-000000000001",
  snapshot: { command: null, phase: "idle", subject: null },
  available: true,
  online: true,
  visible: true,
  busy: false,
  canArchive: true,
  canRetry: true,
  onReconcile: vi.fn(),
  onArchive: vi.fn(),
});

afterEach(() => {
  hooks.slots = [];
  hooks.previous = [];
  hooks.effects = [];
});

describe("archive confirmation focus (ADR-047 review note)", () => {
  it("moves focus to the confirmation step when it opens and back to the request button on cancel", () => {
    const { view } = mount(base());
    const confirmFocus = vi.fn(),
      requestFocus = vi.fn();
    (view().confirmRef as { current: unknown }).current = { focus: confirmFocus };
    (view().requestRef as { current: unknown }).current = { focus: requestFocus };
    expect(view().confirming).toBe(false);
    view().onRequest();
    expect(view().confirming).toBe(true);
    expect(confirmFocus).toHaveBeenCalledOnce();
    expect(requestFocus).not.toHaveBeenCalled();
    view().onCancel();
    expect(view().confirming).toBe(false);
    expect(requestFocus).toHaveBeenCalledOnce();
  });

  it("does not move focus back after confirming the archive", () => {
    const props = base();
    const { view } = mount(props);
    const requestFocus = vi.fn();
    (view().confirmRef as { current: unknown }).current = { focus: vi.fn() };
    (view().requestRef as { current: unknown }).current = { focus: requestFocus };
    view().onRequest();
    vi.stubGlobal("document", { visibilityState: "visible" });
    try {
      view().onConfirm();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(props.onArchive).toHaveBeenCalledOnce();
    expect(view().confirming).toBe(false);
    expect(requestFocus).not.toHaveBeenCalled();
  });

  it("renders the confirmation group as a programmatic focus target with its label", () => {
    const html = renderToStaticMarkup(
      <RecordArchiveView {...base()} confirming onRequest={vi.fn()} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(html).toMatch(/role="group" aria-labelledby="record-archive-contact-confirm" tabindex="-1"/i);
  });
});
