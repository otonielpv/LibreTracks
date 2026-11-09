import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  LOST_NOTICE_AFTER_MS,
  RedundancyNoticeBanner,
  noticeFor,
  useRedundancyNoticeStore,
} from "./redundancyNotice";

const base = { backupUrl: "http://10.0.0.2:3030", handover: false, disconnectedSince: null, dismissed: false, now: 10_000 };

describe("redundancy notice (pure)", () => {
  it("shows the handover at once", () => {
    expect(noticeFor({ ...base, handover: true })).toEqual({ kind: "handover", url: base.backupUrl });
  });

  it("suggests the backup after 3 s without the main", () => {
    expect(noticeFor({ ...base, disconnectedSince: 10_000 - LOST_NOTICE_AFTER_MS + 1 })).toBeNull();
    expect(noticeFor({ ...base, disconnectedSince: 10_000 - LOST_NOTICE_AFTER_MS })).toEqual({
      kind: "lost",
      url: base.backupUrl,
    });
  });

  it("says nothing without a backup address, while connected, or once dismissed", () => {
    expect(noticeFor({ ...base, backupUrl: null, handover: true })).toBeNull();
    expect(noticeFor({ ...base, disconnectedSince: null })).toBeNull();
    expect(noticeFor({ ...base, handover: true, dismissed: true })).toBeNull();
  });
});

const strings = {
  handover: "Se ha activado el respaldo",
  lost: "Se ha perdido la conexión con el principal",
  goToBackup: "Ir al remote del respaldo",
  dismiss: "Cerrar",
};

describe("redundancy notice banner", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useRedundancyNoticeStore.setState({ backupUrl: null, handover: false, disconnectedSince: null, dismissed: false });
  });

  it("links to the backup's remote on a handover and remembers it", () => {
    act(() => useRedundancyNoticeStore.getState().setInfo({ backupRemoteUrl: "http://10.0.0.2:3030", handover: true }));
    render(<RedundancyNoticeBanner strings={strings} />);
    expect(screen.getByRole("alert").textContent).toContain("Se ha activado el respaldo");
    expect(screen.getByRole("link", { name: "Ir al remote del respaldo" }).getAttribute("href")).toBe(
      "http://10.0.0.2:3030",
    );
    expect(window.localStorage.getItem("lt-remote-backup-url")).toBe("http://10.0.0.2:3030");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disappears when the main comes back", () => {
    act(() => {
      useRedundancyNoticeStore.getState().setInfo({ backupRemoteUrl: "http://10.0.0.2:3030" });
      useRedundancyNoticeStore.getState().disconnected(Date.now() - 5000);
    });
    render(<RedundancyNoticeBanner strings={strings} />);
    expect(screen.getByRole("alert").textContent).toContain("Se ha perdido la conexión");
    act(() => useRedundancyNoticeStore.getState().connected());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
