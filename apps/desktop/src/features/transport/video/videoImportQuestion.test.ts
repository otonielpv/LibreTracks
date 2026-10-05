import { beforeEach, describe, expect, it } from "vitest";

import i18n from "../../../shared/i18n";
import type { VideoImportQuestion } from "../desktopApi";
import {
  CLOUD_CELLULAR_CONFIRM_BYTES,
  describeVideoImportQuestion,
  shouldConfirmCloudDownload,
} from "./videoImportQuestion";

const GB = 1024 * 1024 * 1024;
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

function question(extra: Partial<VideoImportQuestion> = {}): VideoImportQuestion {
  return {
    requestId: 1,
    source: "package",
    count: 3,
    bytes: 2.4 * GB,
    freeBytes: 11.2 * GB,
    fits: true,
    defaultInclude: true,
    ...extra,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
});

/** Plan video-mobile, paso 08 C2. */
describe("the 'bring the videos too?' question", () => {
  it("offers them ticked when they fit with a margin, with sizes", () => {
    const view = describeVideoImportQuestion(question(), t, "es")!;
    expect(view.summary).toBe("Este paquete trae 3 vídeos (2,4 GB).");
    expect(view.free).toBe("Espacio libre: 11,2 GB.");
    expect(view.checkboxLabel).toBe("Importar también los vídeos");
    expect(view.hint).toContain("la sesión suena igual");
    expect(view.enabled).toBe(true);
    expect(view.defaultChecked).toBe(true);
  });

  it("leaves them out and disables the box when they do not fit, saying why", () => {
    const view = describeVideoImportQuestion(
      question({ freeBytes: 3 * GB, fits: false, defaultInclude: false }),
      t,
      "es",
    )!;
    expect(view.enabled).toBe(false);
    expect(view.defaultChecked).toBe(false);
    expect(view.hint).toContain("1 GB libre");
  });

  it("never ticks a box that cannot be used, whatever the default says", () => {
    const view = describeVideoImportQuestion(question({ fits: false, defaultInclude: true }), t, "es")!;
    expect(view.defaultChecked).toBe(false);
  });

  it("asks nothing when there are no videos", () => {
    expect(describeVideoImportQuestion(question({ count: 0, bytes: 0 }), t, "es")).toBeNull();
  });

  it("words the copy from the device and a single video", () => {
    const view = describeVideoImportQuestion(
      question({ source: "device", count: 1, bytes: 1 * GB, freeBytes: null }),
      t,
      "es",
    )!;
    expect(view.summary).toBe("Vas a copiar 1 vídeo (1,0 GB) a la sesión.");
    expect(view.free).toBeNull();
    expect(view.checkboxLabel).toBe("Copiar los vídeos");
  });
});

describe("Drive downloads on mobile data (paso 08 §4)", () => {
  it("ask only on a cellular connection and above the threshold", () => {
    expect(shouldConfirmCloudDownload(2 * GB, "cellular")).toBe(true);
    expect(shouldConfirmCloudDownload(CLOUD_CELLULAR_CONFIRM_BYTES, "cellular")).toBe(false);
    expect(shouldConfirmCloudDownload(2 * GB, "wifi")).toBe(false);
    expect(shouldConfirmCloudDownload(2 * GB, null)).toBe(false);
  });
});
