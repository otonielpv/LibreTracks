// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimelineTopbar } from "./TimelineTopbar";
import type { PlaybackState } from "../desktopApi";
import i18n from "../../../shared/i18n";

afterEach(cleanup);

/**
 * Paso 01 del plan de feedback de testers: reproducir y pausa tienen que
 * decir en que estado esta el transporte. Antes `is-play` era fija y el boton
 * se veia igual parado que sonando.
 *
 * El aspecto concreto (degradado turquesa encendido vs. apagado) vive en
 * `shared/styles.css`, y jsdom no calcula maquetacion ni carga esa hoja: lo
 * que este test puede afirmar es que la clase cambia, que es justo el gancho
 * del que cuelga la regla `.is-play.is-active`.
 */
function renderTopbar(playbackState: PlaybackState) {
  const noop = vi.fn();
  return render(
    <TimelineTopbar
      openTopMenu={null}
      menuBarRef={createRef<HTMLDivElement>()}
      canPersistProject
      isProjectEmpty={false}
      tempoDraft="120"
      timeSignatureDraft="4/4"
      tempoSourceLabel={null}
      displayedBpm={120}
      displayedTimeSignature="4/4"
      musicalPositionLabel="1.1.1"
      readoutPositionSecondsLabel="0:00"
      playbackState={playbackState}
      transportReadoutTempoRef={createRef<HTMLElement>()}
      transportReadoutBarRef={createRef<HTMLElement>()}
      transportReadoutValueRef={createRef<HTMLElement>()}
      onToggleTopMenu={noop}
      onTopMenuAction={noop}
      onCreateSong={noop}
      onCreateSongFromTemplate={noop}
      onOpenProject={noop}
      onOpenRecentSession={noop}
      onOpenMobileSessions={noop}
      onImportSong={noop}
      onImportSession={noop}
      onExportSession={noop}
      onOpenCloud={noop}
      onImportExternalProject={noop}
      onSaveProject={noop}
      onSaveProjectAs={noop}
      onSaveAsTemplate={noop}
      onStopTransport={noop}
      runShortcutAction={noop}
      onPlayTransport={noop}
      onPauseTransport={noop}
      onNextSong={noop}
      metronomeEnabled={false}
      onToggleMetronome={noop}
      onOpenMetronome={noop}
      isMetronomePopoverOpen={false}
      voiceGuideEnabled={false}
      onToggleVoiceGuide={noop}
      onOpenVoiceGuide={noop}
      isVoiceGuidePopoverOpen={false}
      padEnabled={false}
      onTogglePads={noop}
      onOpenPads={noop}
      isPadsPopoverOpen={false}
      onTempoDraftChange={noop}
      onTapTempo={noop}
      onTempoCommit={noop}
      onTimeSignatureDraftChange={noop}
      onTimeSignatureCommit={noop}
      midiLearnMode={null}
      onMidiLearnTarget={noop}
    />,
  );
}

function playButton() {
  return screen.getByLabelText(i18n.t("timelineTopbar.play"));
}

function pauseButton() {
  return screen.getByLabelText(i18n.t("timelineTopbar.pause"));
}

describe("TimelineTopbar transport state", () => {
  it("enciende reproducir solo mientras suena", () => {
    renderTopbar("stopped");
    expect(playButton().className).toBe("is-play");
    expect(playButton().getAttribute("aria-pressed")).toBe("false");

    cleanup();
    renderTopbar("playing");
    expect(playButton().className).toBe("is-play is-active");
    expect(playButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("enciende pausa solo cuando esta en pausa", () => {
    renderTopbar("playing");
    expect(pauseButton().className).toBe("");
    expect(pauseButton().getAttribute("aria-pressed")).toBe("false");

    cleanup();
    renderTopbar("paused");
    expect(pauseButton().className).toBe("is-active");
    expect(pauseButton().getAttribute("aria-pressed")).toBe("true");

    // En pausa, reproducir vuelve a estar apagado: nunca hay dos encendidos.
    expect(playButton().className).toBe("is-play");
  });
});
