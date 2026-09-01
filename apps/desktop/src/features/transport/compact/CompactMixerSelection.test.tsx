import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TrackSummary } from "../desktopApi";
import { CompactMixer } from "./CompactMixer";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "trackHeader.expand") return `Expandir ${options?.name}`;
      if (key === "trackHeader.collapse") return `Colapsar ${options?.name}`;
      return key;
    },
  }),
}));

const track = (id: string) =>
  ({
    id,
    name: id,
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

function renderMixer(onEmptyAreaClick: () => void) {
  return render(
    <CompactMixer
      tracks={[track("voz"), track("bateria")]}
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
      selectedTrackIds={["voz"]}
      onTrackSelect={vi.fn()}
      onEmptyAreaClick={onEmptyAreaClick}
      onTrackDragStart={vi.fn()}
      activeSongTrackIds={null}
      filterActiveSong={false}
      collapsedFolders={new Set()}
      onToggleFolder={vi.fn()}
    />,
  );
}

/**
 * El hueco alrededor de las tiras hace en el mixer lo que el fondo del timeline
 * hace en el DAW: deseleccionar. En móvil no hay Escape, así que sin esto una
 * pista marcada aquí no se podía desmarcar.
 */
describe("CompactMixer / deselección", () => {
  it("deselecciona al pulsar el hueco fuera de las tiras", () => {
    const onEmptyAreaClick = vi.fn();
    const { container } = renderMixer(onEmptyAreaClick);

    fireEvent.click(container.querySelector(".lt-compact-mixer") as HTMLElement);

    expect(onEmptyAreaClick).toHaveBeenCalledTimes(1);
  });

  it("no deselecciona al pulsar dentro de una tira", () => {
    const onEmptyAreaClick = vi.fn();
    const { container } = renderMixer(onEmptyAreaClick);

    fireEvent.click(
      container.querySelector(
        '.lt-compact-mixer-strip[data-track-id="voz"]',
      ) as HTMLElement,
    );

    expect(onEmptyAreaClick).not.toHaveBeenCalled();
  });
});
