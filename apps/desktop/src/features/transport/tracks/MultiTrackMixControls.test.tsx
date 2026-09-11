// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackSummary } from "@libretracks/shared/models";

import { MultiTrackMixControls } from "./MultiTrackMixControls";
import { useTransportStore } from "../store";
import i18n from "../../../shared/i18n";

function track(overrides: Partial<TrackSummary> = {}): TrackSummary {
  return {
    id: "t1",
    name: "Bajo",
    kind: "audio",
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: false,
    ...overrides,
  };
}

function mix() {
  return {
    setVolume: vi.fn(),
    commitVolume: vi.fn(),
    setPan: vi.fn(),
    commitPan: vi.fn(),
    setAudioTo: vi.fn(),
  };
}

const ROUTES = [{ value: "master", label: "Master" }];

beforeEach(async () => {
  // jsdom no lo trae; el desplegable de salida mantiene a la vista la opcion
  // activa con el.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  await i18n.changeLanguage("es");
  useTransportStore.setState({ optimisticMix: {} });
});
afterEach(cleanup);

describe("mezcla de una multiseleccion", () => {
  it("habla a UNA pista: los handlers de cabecera ya reparten al resto", () => {
    const actions = mix();
    render(
      <MultiTrackMixControls
        tracks={[track(), track({ id: "t2", name: "Piano" })]}
        routingOptions={ROUTES}
        mix={actions}
      />,
    );

    fireEvent.change(screen.getByLabelText("Volumen de Bajo"), {
      target: { value: "0.4" },
    });

    expect(actions.setVolume.mock.calls[0][0]).toBe("t1");
    expect(screen.getByText("Se aplica a las 2 pistas seleccionadas")).toBeTruthy();
  });

  // Sin esto el fader se quedaria en el valor persistido mientras se arrastra.
  it("sigue la mezcla optimista de la pista de referencia", () => {
    useTransportStore.setState({
      optimisticMix: { t1: { pan: -0.5 } },
    });
    render(
      <MultiTrackMixControls
        tracks={[track(), track({ id: "t2" })]}
        routingOptions={ROUTES}
        mix={mix()}
      />,
    );

    expect(screen.getByText("L 50")).toBeTruthy();
  });

  // "Heredada" solo existe dentro de una carpeta: aplicarla a una pista de
  // primer nivel se descarta en silencio, asi que no se ofrece si alguna no
  // cabe.
  it("ofrece heredar solo cuando todas estan en una carpeta", () => {
    render(
      <MultiTrackMixControls
        tracks={[track({ parentTrackId: "f1" }), track({ id: "t2" })]}
        routingOptions={ROUTES}
        mix={mix()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Audio To/ }));
    expect(screen.queryByRole("option", { name: /Heredad/i })).toBeNull();

    cleanup();
    render(
      <MultiTrackMixControls
        tracks={[
          track({ parentTrackId: "f1" }),
          track({ id: "t2", parentTrackId: "f1" }),
        ]}
        routingOptions={ROUTES}
        mix={mix()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Audio To/ }));
    expect(screen.getByRole("option", { name: /Heredad/i })).toBeTruthy();
  });

  it("sin pistas no pinta nada", () => {
    const { container } = render(
      <MultiTrackMixControls tracks={[]} routingOptions={ROUTES} mix={mix()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
