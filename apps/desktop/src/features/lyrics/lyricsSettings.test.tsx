import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LyricsConfig } from "@libretracks/shared/models";

import i18n from "../../shared/i18n";
import type { LyricsConfigView, LyricsStatus } from "./lyricsApi";
import { DEFAULT_LYRICS_CONFIG, withSoftware } from "./lyricsEdits";
import type { LyricsApi } from "./lyricsHandlers";
import { LyricsSettingsTab } from "./LyricsSettingsTab";
import { LyricsStatusPill } from "./LyricsStatusPill";
import { INITIAL_LYRICS_STATE, selectPillTone, useLyricsStore } from "./lyricsStore";

function makeApi(initial: Partial<LyricsConfig> = {}) {
  let view: LyricsConfigView = {
    config: { ...DEFAULT_LYRICS_CONFIG, ...initial },
    hasToken: false,
  };
  const api = {
    getLyricsConfig: vi.fn(async () => view),
    saveLyricsConfig: vi.fn(async (config: LyricsConfig, token?: string) => {
      view = { config, hasToken: view.hasToken || Boolean(token) };
      return view;
    }),
    probeLyrics: vi.fn(async () => ({ version: "Holyrics 2.30.0", presentations: 12 })),
    setLyricsPaused: vi.fn(async () => undefined),
    refreshLyrics: vi.fn(async () => undefined),
    markLyricsTutorialDone: vi.fn(async (software) => {
      view = {
        ...view,
        config: { ...view.config, tutorialDone: [...view.config.tutorialDone, software] },
      };
      return view;
    }),
    setRegionLyrics: vi.fn(async () => undefined),
    testSendLyrics: vi.fn(async () => undefined),
    getRegionReport: vi.fn(async () => {
      throw new Error("not in this test");
    }),
    getSetlistReport: vi.fn(async () => []),
    stepsFromTaps: vi.fn(async () => []),
    getTapPosition: vi.fn(async () => 0),
    listPresentations: vi.fn(async () => []),
  } satisfies LyricsApi;
  return api;
}

beforeEach(async () => {
  useLyricsStore.setState(INITIAL_LYRICS_STATE);
  await i18n.changeLanguage("es");
});

afterEach(() => {
  cleanup();
});

describe("withSoftware", () => {
  it("follows the program's default port unless the user typed one", () => {
    const holyrics = withSoftware(DEFAULT_LYRICS_CONFIG, "holyrics", false);
    expect(holyrics.port).toBe(8091);
    expect(withSoftware(holyrics, "freeShow", false).port).toBe(5506);
    expect(withSoftware(holyrics, "proPresenter", false).port).toBeNull();
    const typed = { ...holyrics, port: 9000 };
    expect(withSoftware(typed, "freeShow", true).port).toBe(9000);
  });
});

describe("LyricsSettingsTab", () => {
  it("picking a program sets its port and the token never travels inside the config", async () => {
    const api = makeApi({ enabled: true, tutorialDone: ["holyrics", "freeShow", "proPresenter"] });
    render(<LyricsSettingsTab api={api} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Holyrics" }));
    await waitFor(() => expect(api.saveLyricsConfig).toHaveBeenCalled());
    const [config] = api.saveLyricsConfig.mock.calls.at(-1)!;
    expect(config.software).toBe("holyrics");
    expect(config.port).toBe(8091);

    const token = await screen.findByLabelText("Token");
    fireEvent.change(token, { target: { value: "secreto" } });
    fireEvent.blur(token);
    await waitFor(() =>
      expect(api.saveLyricsConfig.mock.calls.at(-1)?.[1]).toBe("secreto"),
    );
    for (const [savedConfig] of api.saveLyricsConfig.mock.calls) {
      expect(JSON.stringify(savedConfig)).not.toContain("secreto");
      expect(savedConfig).not.toHaveProperty("token");
    }
  });

  it("a probe without permissions lists the actions to tick", async () => {
    const api = makeApi({ enabled: true, software: "holyrics", port: 8091, tutorialDone: ["holyrics"] });
    api.probeLyrics.mockRejectedValueOnce({ kind: "unauthorized", missing: ["ActionGoToIndex", "SetF8"] });
    render(<LyricsSettingsTab api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Probar conexión" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Faltan permisos");
    expect(alert.textContent).toContain("ActionGoToIndex");
    expect(alert.textContent).toContain("SetF8");
  });

  it("an unreachable program is explained in plain words with the port tried", async () => {
    const api = makeApi({ enabled: true, software: "freeShow", port: 5506, tutorialDone: ["freeShow"] });
    api.probeLyrics.mockRejectedValueOnce({ kind: "unreachable", detail: "refused" });
    render(<LyricsSettingsTab api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Probar conexión" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No hay respuesta");
    expect(alert.textContent).toContain("5506");
  });

  it("a successful probe shows the version and how many songs it found", async () => {
    const api = makeApi({ enabled: true, software: "holyrics", port: 8091, tutorialDone: ["holyrics"] });
    render(<LyricsSettingsTab api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Probar conexión" }));
    expect((await screen.findByRole("status")).textContent).toContain("Holyrics 2.30.0");
  });
});

describe("setup tutorial", () => {
  it("appears the first time a program is picked and can be skipped", async () => {
    const api = makeApi({ enabled: true });
    render(<LyricsSettingsTab api={api} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Holyrics" }));
    const tutorial = await screen.findByRole("region", { name: "Configurar Holyrics" });
    expect(tutorial.textContent).toContain("Paso 1 de 5");
    expect(tutorial.textContent).toContain("API Server");
    fireEvent.click(screen.getByRole("button", { name: "Saltar tutorial" }));
    await waitFor(() => expect(api.markLyricsTutorialDone).toHaveBeenCalledWith("holyrics"));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Configurar Holyrics" })).toBeNull(),
    );
  });

  it("walks forward and back, finishes, and can be opened again", async () => {
    const api = makeApi({ enabled: true, software: "proPresenter" });
    render(<LyricsSettingsTab api={api} />);
    const region = await screen.findByRole("region", { name: "Configurar ProPresenter" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(region.textContent).toContain("Paso 2 de 5");
    expect(region.textContent).toContain("Habilitar red");
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    expect(region.textContent).toContain("Paso 1 de 5");
    for (let step = 0; step < 4; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    }
    expect(region.textContent).toContain("Listo para probar");
    expect(screen.queryByRole("button", { name: "Saltar tutorial" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Entendido" }));
    await waitFor(() => expect(api.markLyricsTutorialDone).toHaveBeenCalledWith("proPresenter"));
    fireEvent.click(await screen.findByRole("button", { name: "Ver el tutorial" }));
    expect(await screen.findByRole("region", { name: "Configurar ProPresenter" })).toBeTruthy();
  });

  it("is not shown for a program already set up", async () => {
    const api = makeApi({ enabled: true, software: "freeShow", tutorialDone: ["freeShow"] });
    render(<LyricsSettingsTab api={api} />);
    await screen.findByRole("button", { name: "Ver el tutorial" });
    expect(screen.queryByRole("region", { name: "Configurar FreeShow" })).toBeNull();
  });
});

function status(partial: Partial<LyricsStatus>): LyricsStatus {
  return { connection: { state: "ok" }, lastSent: null, lastError: null, unlinkedSongs: 0, ...partial };
}

function configured(partial: Partial<LyricsConfig> = {}) {
  useLyricsStore.getState().setConfigView({
    config: { ...DEFAULT_LYRICS_CONFIG, enabled: true, software: "holyrics", port: 8091, ...partial },
    hasToken: true,
  });
}

describe("LyricsStatusPill", () => {
  it("is not mounted with the sync off", () => {
    useLyricsStore.getState().setConfigView({ config: DEFAULT_LYRICS_CONFIG, hasToken: false });
    useLyricsStore.getState().setStatus(status({}));
    render(<LyricsStatusPill api={makeApi()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("goes through its four colours", () => {
    configured();
    const { container } = render(<LyricsStatusPill api={makeApi()} />);
    const pill = () => container.querySelector(".lt-lyrics-pill")!;
    act(() => useLyricsStore.getState().setStatus(status({})));
    expect(pill().className).toContain("is-ok");
    act(() => useLyricsStore.getState().setStatus(status({ unlinkedSongs: 2 })));
    expect(pill().className).toContain("is-warning");
    act(() => useLyricsStore.getState().setStatus(status({ connection: { state: "unreachable" } })));
    expect(pill().className).toContain("is-error");
    act(() =>
      useLyricsStore.getState().setStatus(status({ connection: { state: "unauthorized", missing: ["SetF8"] } })),
    );
    expect(pill().className).toContain("is-error");
    act(() => useLyricsStore.getState().setStatus(status({ connection: { state: "paused" } })));
    expect(pill().className).toContain("is-paused");
  });

  it("pause sending calls the command and turns the pill grey", async () => {
    configured();
    useLyricsStore.getState().setStatus(status({}));
    const api = makeApi();
    const { container } = render(<LyricsStatusPill api={api} />);
    fireEvent.click(container.querySelector(".lt-lyrics-pill")!);
    fireEvent.click(screen.getByRole("button", { name: "Pausar envío" }));
    await waitFor(() => expect(api.setLyricsPaused).toHaveBeenCalledWith(true));
    await waitFor(() => expect(container.querySelector(".lt-lyrics-pill")!.className).toContain("is-paused"));
    expect(selectPillTone(useLyricsStore.getState())).toBe("paused");
  });
});
