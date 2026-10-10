import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";
// Lyrics ship behind a compile-time flag; these tests drive it.
const flags = vi.hoisted(() => ({ lyrics: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));

import { LivePerformanceView } from "./LivePerformanceView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; time?: string; count?: number }) => {
      const messages: Record<string, string> = {
        "liveView.title": "Live View",
        "liveView.selectSong": `Show markers for ${values?.name}`,
        "liveView.playSong": `Play ${values?.name}`,
        "liveView.reorderSong": `Reorder ${values?.name}`,
        "liveView.songProgress": "Current song progress",
      };
      return messages[key] ?? key;
    },
  }),
}));

const region = (
  id: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
): SongRegionSummary => ({
  id,
  name,
  startSeconds,
  endSeconds,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
});

const song: SongView = {
  id: "session",
  title: "Directo",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 80,
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [
    region("first", "Primera", 0, 40),
    region("second", "Segunda", 40, 80),
  ],
  sectionMarkers: [
    { id: "verse", name: "Estrofa", startSeconds: 10, kind: "verse" },
    { id: "chorus", name: "Estribillo", startSeconds: 50, kind: "chorus" },
  ],
  clips: [],
  tracks: [],
  projectRevision: 1,
};

describe("LivePerformanceView", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("filters markers by selection and keeps song playback on a separate button", () => {
    const onSongAction = vi.fn();
    const renderView = (
      pendingMarkerId: string | null = null,
      pendingMarkerName: string | null = null,
    ) => (
      <LivePerformanceView
        song={song}
        positionSecondsRef={{ current: 10 }}
        settings={DEFAULT_APP_SETTINGS}
        pendingMarkerId={pendingMarkerId}
        pendingMarkerName={pendingMarkerName}
        activeVamp={null}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={onSongAction}
        onChartChange={vi.fn()}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={vi.fn()}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />
    );
    const { container, rerender } = render(renderView());

    expect(screen.getByText("Estrofa")).toBeTruthy();
    expect(container.querySelector(".lt-live-execution")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "liveView.cancelJump" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText("Estribillo")).toBeNull();
    expect(
      screen.getByRole("progressbar", { name: "Current song progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("25");

    fireEvent.click(screen.getByRole("button", { name: "Show markers for Segunda" }));
    expect(screen.queryByText("Estrofa")).toBeNull();
    expect(screen.getByText("Estribillo")).toBeTruthy();
    expect(onSongAction).not.toHaveBeenCalled();
    expect(container.querySelector(".lt-live-cue-progress")).toBeTruthy();
    expect(container.querySelector(".lt-live-cue-progress.is-active")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Play Segunda" }));
    expect(onSongAction).toHaveBeenCalledWith(song.regions[1]);

    rerender(renderView("second", "Segunda"));

    const queuedSong = container.querySelector(".lt-live-region-row.is-queued");
    expect(queuedSong?.textContent).toContain("Segunda");
    expect(queuedSong?.textContent).toContain("liveView.queued");
    expect(
      (screen.getByRole("button", { name: "liveView.cancelJump" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("exposes the song transition and identifies the marker repeated by VAMP", () => {
    const onSongTransitionModeChange = vi.fn();
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      songTransitionMode: "fade_out" as const,
      vampMode: "bars" as const,
      vampBars: 4,
    };

    const { container } = render(
      <LivePerformanceView
        song={song}
        positionSecondsRef={{ current: 10 }}
        settings={settings}
        pendingMarkerId={null}
        pendingMarkerName={null}
        activeVamp={{ startSeconds: 10, endSeconds: 18 }}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={vi.fn()}
        onChartChange={vi.fn()}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={onSongTransitionModeChange}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "liveView.fadeOut" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "liveView.cleanCut" }));
    expect(onSongTransitionModeChange).toHaveBeenCalledWith("instant");
    expect(container.querySelector(".lt-live-cue-row.is-vamp")?.textContent)
      .toContain("liveView.vampBarsBadge");
  });
  it("pone la cuenta atras en la linea del nombre, no al final de la fila", () => {
    // La cancion de prueba tiene una sola marca por region, asi que nunca hay
    // una "siguiente" a la que contarle el tiempo: la primera region gana una.
    const songWithTwoMarkersInFirstRegion: SongView = {
      ...song,
      sectionMarkers: [
        ...song.sectionMarkers,
        { id: "prechorus", name: "Preestribillo", startSeconds: 25, kind: "verse" },
      ],
    };

    // La lista se desplaza para centrar la marca ACTIVA, asi que la SIGUIENTE
    // -la que lleva la cuenta atras- suele quedar a medias contra el borde
    // inferior del scroll, y lo ultimo de la fila es lo primero que se corta.
    // Reportado como "el texto de siguiente se mete por debajo del boton" y
    // reproducido en un iPhone 13 en horizontal. En la linea del nombre se lee
    // aunque la fila salga a medias.
    const { container } = render(
      <LivePerformanceView
        song={songWithTwoMarkersInFirstRegion}
        positionSecondsRef={{ current: 10 }}
        settings={DEFAULT_APP_SETTINGS}
        pendingMarkerId={null}
        pendingMarkerName={null}
        activeVamp={null}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={vi.fn()}
        onChartChange={vi.fn()}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={vi.fn()}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />,
    );

    const countdown = container.querySelector("em.is-countdown");
    expect(countdown).not.toBeNull();
    expect(countdown?.textContent).toContain("liveView.nextIn");
    // Lo que se fija es DONDE vive, que es todo el arreglo.
    expect(countdown?.parentElement?.className).toBe("lt-live-cue-name-line");
  });

  it("imports lyrics for the song shown, from the live view", async () => {
    window.localStorage.clear();
    const onChartChange = vi.fn(async () => {});
    render(
      <LivePerformanceView
        song={song}
        positionSecondsRef={{ current: 10 }}
        settings={DEFAULT_APP_SETTINGS}
        pendingMarkerId={null}
        pendingMarkerName={null}
        activeVamp={null}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={vi.fn()}
        onChartChange={onChartChange}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={vi.fn()}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />,
    );
    const sheet = "Verso 1\nUna linea";
    const file = new File([sheet], "letra.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: async () => sheet });
    await act(async () => {
      fireEvent.change(screen.getByTestId("live-chart-file-input"), { target: { files: [file] } });
    });
    expect(onChartChange).toHaveBeenCalledWith("first", expect.objectContaining({ text: expect.stringContaining("Una linea") }));
  });

  it("with the lyrics flag off, the live view is the markers alone", () => {
    flags.lyrics = false;
    try {
      window.localStorage.clear();
      const { container } = render(
        <LivePerformanceView
          song={song}
          positionSecondsRef={{ current: 10 }}
          settings={DEFAULT_APP_SETTINGS}
          pendingMarkerId={null}
          pendingMarkerName={null}
          activeVamp={null}
          onViewModeChange={vi.fn()}
          onMarkerAction={vi.fn()}
          onSongAction={vi.fn()}
          onChartChange={vi.fn()}
          onToggleVamp={vi.fn()}
          onCancelPendingJump={vi.fn()}
          onGlobalJumpModeChange={vi.fn()}
          onGlobalJumpBarsChange={vi.fn()}
          onSongJumpTriggerChange={vi.fn()}
          onSongJumpBarsChange={vi.fn()}
          onSongTransitionModeChange={vi.fn()}
          onVampModeChange={vi.fn()}
          onVampBarsChange={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: "liveChart.toggle" })).toBeNull();
      expect(container.querySelector(".lt-live-chart")).toBeNull();
      expect(container.querySelector(".lt-live-view.has-chart")).toBeNull();
    } finally {
      flags.lyrics = true;
    }
  });

  it("hides and shows the lyrics panel from the header, and remembers it", () => {
    window.localStorage.clear();
    const view = () => (
      <LivePerformanceView
        song={song}
        positionSecondsRef={{ current: 10 }}
        settings={DEFAULT_APP_SETTINGS}
        pendingMarkerId={null}
        pendingMarkerName={null}
        activeVamp={null}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={vi.fn()}
        onChartChange={vi.fn()}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={vi.fn()}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />
    );
    const { container, unmount } = render(view());
    expect(container.querySelector(".lt-live-chart")).not.toBeNull();
    expect(container.querySelector(".lt-live-view.has-chart")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "liveChart.toggle" }));
    expect(container.querySelector(".lt-live-chart")).toBeNull();
    expect(container.querySelector(".lt-live-view.has-chart")).toBeNull();

    // And back, then closed from the panel's own button.
    fireEvent.click(screen.getByRole("button", { name: "liveChart.toggle" }));
    expect(container.querySelector(".lt-live-chart")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "liveChart.hide" }));
    expect(container.querySelector(".lt-live-chart")).toBeNull();

    // Reopening the view keeps it hidden.
    unmount();
    const again = render(view());
    expect(again.container.querySelector(".lt-live-chart")).toBeNull();
    window.localStorage.clear();
  });

  it("keeps the setlist in the header, in start order, reorderable by its grips", () => {
    const onReorderSong = vi.fn();
    const renderSetlist = (withReorder: boolean) => (
      <LivePerformanceView
        // Desordenadas a propósito: la setlist se pinta por inicio.
        song={{ ...song, regions: [song.regions[1], song.regions[0]] }}
        positionSecondsRef={{ current: 10 }}
        settings={DEFAULT_APP_SETTINGS}
        pendingMarkerId={null}
        pendingMarkerName={null}
        activeVamp={null}
        onViewModeChange={vi.fn()}
        onMarkerAction={vi.fn()}
        onSongAction={vi.fn()}
        onReorderSong={withReorder ? onReorderSong : undefined}
        onChartChange={vi.fn()}
        onToggleVamp={vi.fn()}
        onCancelPendingJump={vi.fn()}
        onGlobalJumpModeChange={vi.fn()}
        onGlobalJumpBarsChange={vi.fn()}
        onSongJumpTriggerChange={vi.fn()}
        onSongJumpBarsChange={vi.fn()}
        onSongTransitionModeChange={vi.fn()}
        onVampModeChange={vi.fn()}
        onVampBarsChange={vi.fn()}
      />
    );
    const { rerender } = render(renderSetlist(true));

    const header = screen.getByRole("banner");
    const songs = header.querySelectorAll(".lt-live-region-select");
    expect([...songs].map((button) => button.textContent)).toEqual(["1Primera", "2Segunda"]);
    expect(header.querySelector("[role='progressbar']")).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Primera" }), {
      key: "ArrowDown",
    });
    expect(onReorderSong).toHaveBeenCalledWith("first", 1);

    rerender(renderSetlist(false));
    expect(screen.queryByRole("button", { name: "Reorder Primera" })).toBeNull();
  });
});
