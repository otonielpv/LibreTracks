import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackSummary } from "../desktopApi";
import { createReorderPreview } from "../reorder/reorderPreview";
import { meterTickerStats } from "../tracks/meterTicker";
import { compactStripItems } from "../tracks/useTrackDragPreview";
import { useTimelineUIStore } from "../uiStore";
import { CompactMixer } from "./CompactMixer";
import { getCompactStripLayout, resetMixerStripWindowForTest } from "./useMixerStripWindow";

/**
 * Paso 06 de `docs/plans/track-virtualization`: el mezclador compacto sin el
 * filtro de cancion activa montaba las 138 tiras de la sesion. Ahora monta las
 * cercanas a lo visible, con el ancho total exacto.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STRIP_WIDTH = 104;
const GAP = 6.4;
const PITCH = STRIP_WIDTH + GAP;
const VIEWPORT_WIDTH = 1200;

const track = (index: number) =>
  ({
    id: `t${index}`,
    name: `t${index}`,
    kind: "audio",
    parentTrackId: null,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    transposeEnabled: false,
    audioTo: "master",
    color: null,
  }) as unknown as TrackSummary;

const tracksOf = (count: number) => Array.from({ length: count }, (_, index) => track(index));

let scrollLeft = 0;

function renderMixer(tracks: TrackSummary[]) {
  return render(
    <CompactMixer
      tracks={tracks}
      audioRoutingOptions={[{ value: "master", label: "Master" }]}
      handlers={{
        onToggleMute: vi.fn(),
        onToggleSolo: vi.fn(),
        onToggleTranspose: vi.fn(),
        onVolumeChange: vi.fn(),
        onCommitVolume: vi.fn(),
        onPanChange: vi.fn(),
        onCommitPan: vi.fn(),
        onAudioToChange: vi.fn(),
      }}
      onTrackContextMenu={vi.fn()}
      selectedTrackIds={[]}
      onTrackSelect={vi.fn()}
      onTrackDragStart={vi.fn()}
      activeSongTrackIds={null}
      filterActiveSong={false}
      collapsedFolders={new Set()}
      onToggleFolder={vi.fn()}
    />,
  );
}

const scroller = () => document.querySelector<HTMLElement>(".lt-compact-mixer-strips")!;
const mountedStripIds = () =>
  [...document.querySelectorAll<HTMLElement>(".lt-compact-mixer-strip")].map(
    (strip) => strip.dataset.trackId!,
  );

/** Ancho del contenido en el flex: cada hijo con su ancho, y un gap entre dos. */
function contentWidth() {
  const children = [...scroller().children] as HTMLElement[];
  const widths = children.map((child) =>
    child.classList.contains("lt-compact-mixer-spacer")
      ? Number.parseFloat(child.style.width)
      : STRIP_WIDTH,
  );
  return widths.reduce((sum, width) => sum + width, 0) + GAP * (children.length - 1);
}

/** Inicio de cada tira montada en el contenido, en el mismo calculo. */
function stripStarts() {
  const starts = new Map<string, number>();
  let cursor = 0;
  for (const child of [...scroller().children] as HTMLElement[]) {
    const isSpacer = child.classList.contains("lt-compact-mixer-spacer");
    if (!isSpacer) starts.set(child.dataset.trackId!, cursor);
    cursor += (isSpacer ? Number.parseFloat(child.style.width) : STRIP_WIDTH) + GAP;
  }
  return starts;
}

async function scrollTo(value: number) {
  scrollLeft = value;
  await act(async () => {
    scroller().dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

beforeEach(() => {
  scrollLeft = 0;
  useTimelineUIStore.setState({ trackReorderMode: false });
  resetMixerStripWindowForTest();
  // jsdom no carga el CSS ni tiene layout: el ancho de tira, el gap y el visor.
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = realGetComputedStyle(element, pseudo);
    if (element instanceof HTMLElement && element.classList.contains("lt-compact-mixer-strip")) {
      return { ...style, width: `${STRIP_WIDTH}px` } as CSSStyleDeclaration;
    }
    if (element instanceof HTMLElement && element.classList.contains("lt-compact-mixer-strips")) {
      return { ...style, columnGap: `${GAP}px`, gap: `${GAP}px` } as CSSStyleDeclaration;
    }
    return style;
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("lt-compact-mixer-strips") ? VIEWPORT_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("lt-compact-mixer-strips") ? scrollLeft : 0;
    },
    set(this: HTMLElement, value: number) {
      if (this.classList.contains("lt-compact-mixer-strips")) scrollLeft = value;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollLeft");
});

describe("compact mixer strip window", () => {
  it("mounts only the strips near the visible band out of 138", () => {
    renderMixer(tracksOf(138));

    const mounted = mountedStripIds();
    const visible = Math.ceil(VIEWPORT_WIDTH / PITCH);
    expect(mounted.length).toBeGreaterThanOrEqual(visible);
    expect(mounted.length).toBeLessThanOrEqual(2 * visible + 2 + 8);
    expect(meterTickerStats().registered).toBe(mounted.length);
  });

  it("keeps the exact content width and each strip in its slot", async () => {
    renderMixer(tracksOf(138));
    const fullWidth = 138 * STRIP_WIDTH + 137 * GAP;

    for (const position of [0, 6000, fullWidth - VIEWPORT_WIDTH]) {
      await scrollTo(position);
      expect(contentWidth()).toBeCloseTo(fullWidth, 6);
      for (const [id, start] of stripStarts()) {
        expect(start).toBeCloseTo(Number(id.slice(1)) * PITCH, 6);
      }
    }
    expect(mountedStripIds()).toContain("t137");
  });

  it("mounts every strip at or below the threshold, and with no geometry", () => {
    renderMixer(tracksOf(48));
    expect(mountedStripIds()).toHaveLength(48);
    expect(document.querySelectorAll(".lt-compact-mixer-spacer")).toHaveLength(0);
    cleanup();

    vi.mocked(window.getComputedStyle).mockRestore();
    resetMixerStripWindowForTest();
    renderMixer(tracksOf(138));
    expect(mountedStripIds()).toHaveLength(138);
    expect(document.querySelectorAll(".lt-compact-mixer-spacer")).toHaveLength(0);
  });

  it("keeps the pressed strip mounted while it scrolls away", async () => {
    renderMixer(tracksOf(138));
    fireEvent.pointerDown(document.querySelector('[data-track-id="t1"]')!);

    await scrollTo(10_000);
    expect(mountedStripIds()).toContain("t1");
    expect(stripStarts().get("t1")).toBeCloseTo(PITCH, 6);

    await act(async () => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(mountedStripIds()).not.toContain("t1");
  });

  it("auto-scrolls left and right while dragging a track near the mixer edges", async () => {
    useTimelineUIStore.setState({ trackReorderMode: true });
    renderMixer(tracksOf(30));
    const viewport = scroller();
    viewport.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: VIEWPORT_WIDTH,
        bottom: 300,
        width: VIEWPORT_WIDTH,
        height: 300,
      }) as DOMRect;

    const pointer = (
      target: Element | Window,
      type: "pointerdown" | "pointermove" | "pointerup",
      clientX: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY: 40,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: "touch" },
      });
      fireEvent(target, event);
    };
    const waitForScrollFrame = () =>
      new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    scrollLeft = 500;
    await act(async () => {
      const name = document.querySelector<HTMLElement>(
        '[data-track-id="t1"] [data-strip-noninteractive]',
      )!;
      pointer(name, "pointerdown", 100);
      pointer(window, "pointermove", 20);
      await waitForScrollFrame();
      pointer(window, "pointerup", 20);
    });
    expect(scrollLeft).toBeLessThan(500);

    scrollLeft = 500;
    await act(async () => {
      const name = document.querySelector<HTMLElement>(
        '[data-track-id="t1"] [data-strip-noninteractive]',
      )!;
      pointer(name, "pointerdown", 1100);
      pointer(window, "pointermove", 1190);
      await waitForScrollFrame();
      pointer(window, "pointerup", 1190);
    });
    expect(scrollLeft).toBeGreaterThan(500);
  });

  it("reorders against every strip, mounted or not", () => {
    renderMixer(tracksOf(138));
    const layout = getCompactStripLayout();
    expect(layout?.ids).toHaveLength(138);

    const items = compactStripItems(document, layout!, "t0");
    expect(items?.items).toHaveLength(138);
    const preview = createReorderPreview({
      items: items!.items,
      axis: "x",
      liftSource: null,
      pointer: { x: 0, y: 0 },
      layoutAnchor: items!.anchor,
    });
    // jsdom: la tira ancla mide 0 en pantalla, asi que el origen es 0. Una
    // tira lejana, sin montar, sigue siendo un destino.
    expect(preview.hitTest(120 * PITCH + 10, 0)).toEqual({
      id: "t120",
      ratio: 10 / STRIP_WIDTH,
    });
  });
});
