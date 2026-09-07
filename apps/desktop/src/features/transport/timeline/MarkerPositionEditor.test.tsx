// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkerPositionEditor } from "./MarkerPositionEditor";
import { useTimelineUIStore } from "../uiStore";
import type { SongView } from "../desktopApi";
import i18n from "../../../shared/i18n";

const song = {
  id: "s",
  title: "Sesion",
  bpm: 120,
  timeSignature: "4/4",
  durationSeconds: 120,
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [],
  // 4 s a 120 bpm 4/4 = compas 3.
  sectionMarkers: [{ id: "m1", name: "Estrofa", startSeconds: 4 }],
  clips: [],
  tracks: [],
  projectRevision: 1,
} as unknown as SongView;

function open(markerId: string | null) {
  useTimelineUIStore.getState().setMarkerPositionEditorId(markerId);
}

function renderEditor(onCommit = vi.fn()) {
  render(
    <MarkerPositionEditor
      song={song}
      workspaceEndSeconds={600}
      onCommit={onCommit}
    />,
  );
  return onCommit;
}

const bar = () => screen.getByLabelText("Compás.tiempo") as HTMLInputElement;
const secs = () => screen.getByLabelText("Segundos") as HTMLInputElement;

beforeEach(async () => {
  await i18n.changeLanguage("es");
  open(null);
});
afterEach(cleanup);

describe("corregir la posicion de una marca a mano", () => {
  it("no ocupa sitio mientras no se pide", () => {
    renderEditor();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("arranca en donde esta la marca, no en el cabezal", () => {
    open("m1");
    renderEditor();
    expect(bar().value).toBe("3.1.00");
    expect(secs().value).toBe("4.000");
  });

  it("los dos campos son la misma posicion y se siguen", () => {
    open("m1");
    renderEditor();

    fireEvent.change(bar(), { target: { value: "5.1.00" } });
    expect(Number(secs().value)).toBeCloseTo(8, 2);

    fireEvent.change(secs(), { target: { value: "2" } });
    expect(bar().value).toBe("2.1.00");
  });

  it("escribir a medias no mueve nada", () => {
    open("m1");
    renderEditor();
    fireEvent.change(bar(), { target: { value: "" } });
    expect(secs().value).toBe("4.000");
  });

  it("aplicar guarda por el MISMO camino que arrastrar la bandera", () => {
    open("m1");
    const onCommit = renderEditor();
    fireEvent.change(bar(), { target: { value: "5.1.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [markerId, seconds] = onCommit.mock.calls[0];
    expect(markerId).toBe("m1");
    expect(seconds).toBeCloseTo(8, 2);
    expect(useTimelineUIStore.getState().markerPositionEditorId).toBeNull();
  });

  it("cancelar no toca la marca", () => {
    open("m1");
    const onCommit = renderEditor();
    fireEvent.change(secs(), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(useTimelineUIStore.getState().markerPositionEditorId).toBeNull();
  });

  it("lo que se guarda no se sale del espacio de trabajo", () => {
    open("m1");
    const onCommit = renderEditor();
    // El campo deja escribir lo que sea -corregir a mitad de teclear es
    // insoportable-, pero lo que se guarda va recortado al tope.
    fireEvent.change(secs(), { target: { value: "99999" } });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(onCommit).toHaveBeenCalledWith("m1", 600);
  });
});
