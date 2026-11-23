import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ chartSources: true }));
vi.mock("@libretracks/shared/featureFlags", () => ({ FEATURE_FLAGS: flags }));

const api = vi.hoisted(() => ({
  getPcoStatus: vi.fn(),
  signInPco: vi.fn(),
  signOutPco: vi.fn(),
}));
vi.mock("../transport/desktopApi", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "name" in options ? `${key}:${options.name}·${options.organization}` : key,
  }),
}));

import { createChartSourceHandlers, type ChartSourceApi } from "./chartSourceHandlers";
import { INITIAL_CHART_SOURCE_STATE, useChartSourceStore } from "./chartSourceStore";
import { PlanningCenterAccountRow } from "./PlanningCenterAccountRow";
import { CHART_SOURCE_TEXTS } from "./chartSourceTexts";

const status = (state: "disconnected" | "connected" | "expired", extra = {}) => ({
  configured: true,
  state,
  account: state === "connected" ? { name: "Ana Ejemplo", organization: "Iglesia" } : null,
  error: null,
  ...extra,
});

async function renderRow() {
  render(
    <ul>
      <PlanningCenterAccountRow />
    </ul>,
  );
  await act(async () => {});
}

beforeEach(() => {
  flags.chartSources = true;
  useChartSourceStore.setState({ ...INITIAL_CHART_SOURCE_STATE });
  api.getPcoStatus.mockReset();
  api.signInPco.mockReset();
  api.signOutPco.mockReset();
});
afterEach(cleanup);

describe("the Planning Center account row", () => {
  it("disconnected: offers to connect", async () => {
    api.getPcoStatus.mockResolvedValue(status("disconnected"));
    await renderRow();
    expect(screen.getByText("chartSources.account.notConnected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "chartSources.account.connect" })).toBeTruthy();
  });

  it("connected: shows who and where, and disconnects", async () => {
    api.getPcoStatus.mockResolvedValue(status("connected"));
    api.signOutPco.mockResolvedValue(undefined);
    await renderRow();
    expect(screen.getByText("chartSources.account.accountLabel:Ana Ejemplo·Iglesia")).toBeTruthy();
    api.getPcoStatus.mockResolvedValue(status("disconnected"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /chartSources.account.disconnect/ }));
    });
    expect(api.signOutPco).toHaveBeenCalledTimes(1);
    expect(screen.getByText("chartSources.account.notConnected")).toBeTruthy();
  });

  it("expired: asks to connect again", async () => {
    api.getPcoStatus.mockResolvedValue(status("expired"));
    await renderRow();
    expect(screen.getByText("chartSources.account.expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "chartSources.account.reconnect" })).toBeTruthy();
  });

  it("explains a user without Services access", async () => {
    api.getPcoStatus.mockResolvedValue(status("connected", { account: null, error: { code: "noServicesAccess" } }));
    await renderRow();
    expect(screen.getByRole("alert").textContent).toBe("chartSources.errors.noServicesAccess");
  });

  it("is not there with the flag off, nor in a build that cannot sign in", async () => {
    flags.chartSources = false;
    api.getPcoStatus.mockResolvedValue(status("connected"));
    await renderRow();
    expect(screen.queryByTestId("pco-account")).toBeNull();
    expect(api.getPcoStatus).not.toHaveBeenCalled();
    cleanup();

    flags.chartSources = true;
    api.getPcoStatus.mockResolvedValue({ ...status("disconnected"), configured: false });
    await renderRow();
    expect(screen.queryByTestId("pco-account")).toBeNull();
  });
});

describe("chart source handlers", () => {
  it("connect signs in once even when pressed twice", async () => {
    let finish: () => void = () => {};
    api.signInPco.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    api.getPcoStatus.mockResolvedValue(status("connected"));
    const handlers = createChartSourceHandlers({ api: api as unknown as ChartSourceApi, store: useChartSourceStore });
    const first = handlers.connect();
    const second = handlers.connect();
    expect(useChartSourceStore.getState().connecting).toBe(true);
    finish();
    await Promise.all([first, second]);
    expect(api.signInPco).toHaveBeenCalledTimes(1);
    expect(useChartSourceStore.getState()).toMatchObject({ connecting: false, status: { state: "connected" } });
  });

  it("keeps the typed error of a failed sign-in", async () => {
    api.signInPco.mockRejectedValue({ code: "network", message: "offline" });
    const handlers = createChartSourceHandlers({ api: api as unknown as ChartSourceApi, store: useChartSourceStore });
    await handlers.connect();
    expect(useChartSourceStore.getState().error).toEqual({ code: "network", message: "offline" });
  });
});

describe("chart source texts", () => {
  it("has every English key in Spanish, without long dashes", () => {
    const keys = (value: object, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string" ? [`${prefix}${key}`] : keys(child as object, `${prefix}${key}.`),
      );
    expect(keys(CHART_SOURCE_TEXTS.es)).toEqual(keys(CHART_SOURCE_TEXTS.en));
    expect(JSON.stringify(CHART_SOURCE_TEXTS)).not.toContain("—");
  });
});
