import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryAssetSummary,
  LibraryImportProgressEvent,
} from "@libretracks/shared/models";
import {
  runAndroidLibraryImport,
  runIosLibraryImport,
  type IosLibraryImportDeps,
  type MobileLibraryImportDeps,
} from "./mobileLibraryImport";
import {
  createClipsWithAutoTracks,
  importLibraryAssetsFromDialog,
  importStagedAudioFiles,
} from "../desktopApi";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import { pickFilesViaWebView, stageFileForImport } from "./mobileFilePicker";
import { useTransportStore } from "../store";

vi.mock("../desktopApi", () => ({
  createClipsWithAutoTracks: vi.fn(async () => ({})),
  importLibraryAssetsFromDialog: vi.fn(async () => null),
  importStagedAudioFiles: vi.fn(async () => ({ assets: [], skipped: [] })),
  forgetLibraryAssets: vi.fn(async () => []),
}));
vi.mock("../../../shared/dialog/dialogService", () => ({
  confirmDialog: vi.fn(async () => false),
  alertDialog: vi.fn(async () => {}),
}));
vi.mock("./mobileFilePicker", () => ({
  pickFilesViaWebView: vi.fn(async () => []),
  stageFileForImport: vi.fn(async () => "/staged/file.wav"),
}));

function asset(fileName: string): LibraryAssetSummary {
  return {
    fileName,
    filePath: `audio/${fileName}`,
    durationSeconds: 1,
    isMissing: false,
    folderPath: null,
  };
}

/** Records every flip of the spinner flag, in order. */
type SpinnerLog = {
  importing: boolean[];
  progress: (LibraryImportProgressEvent | null)[];
};

function makeDeps(existing: LibraryAssetSummary[] = []): {
  deps: MobileLibraryImportDeps;
  log: SpinnerLog;
} {
  const log: SpinnerLog = { importing: [], progress: [] };
  return {
    log,
    deps: {
      libraryAssets: existing,
      t: (key, options) => `${key}${options ? JSON.stringify(options) : ""}`,
      setStatus: vi.fn(),
      mergeLibraryAssets: vi.fn(),
      refreshLibraryState: vi.fn(async () => undefined),
      applyPlaybackSnapshot: vi.fn(),
      getImportPositionSeconds: () => 0,
      setIsImportingLibrary: (importing) => log.importing.push(importing),
      setLibraryImportProgress: (progress) => log.progress.push(progress),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTransportStore.setState({ pendingAudioImports: [] });
});

describe("import de biblioteca en Android", () => {
  it("enciende el indicador mientras importa y lo apaga al terminar", async () => {
    vi.mocked(importLibraryAssetsFromDialog).mockResolvedValue([
      asset("bass.wav"),
    ]);
    const { deps, log } = makeDeps();

    await runAndroidLibraryImport(deps);

    // On before the backend call, off after it: the panel shows the spinner for
    // the whole copy and nothing lingers once it is done.
    expect(log.importing).toEqual([true, false]);
  });

  it("apaga el indicador cuando el usuario cancela el selector", async () => {
    vi.mocked(importLibraryAssetsFromDialog).mockResolvedValue(null);
    const { deps, log } = makeDeps();

    await runAndroidLibraryImport(deps);

    expect(log.importing).toEqual([true, false]);
  });

  it("apaga el indicador cuando el import falla", async () => {
    vi.mocked(importLibraryAssetsFromDialog).mockRejectedValue(
      new Error("no se pudo leer"),
    );
    const { deps, log } = makeDeps();

    await expect(runAndroidLibraryImport(deps)).rejects.toThrow(
      "no se pudo leer",
    );
    // A spinner left spinning after a failure is worse than no spinner: the
    // panel would look busy forever and the import button stays disabled.
    expect(log.importing).toEqual([true, false]);
  });

  it("ofrece llevar al timeline solo lo que no estaba ya en la biblioteca", async () => {
    vi.mocked(importLibraryAssetsFromDialog).mockResolvedValue([
      asset("old.wav"),
      asset("new.wav"),
    ]);
    const { deps } = makeDeps([asset("old.wav")]);

    await runAndroidLibraryImport(deps);

    // The backend event carries the FULL list; only `new.wav` just arrived.
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(confirmDialog).mock.calls[0][0] as string;
    expect(prompt).toContain('"count":1');
    expect(vi.mocked(createClipsWithAutoTracks)).not.toHaveBeenCalled();
  });
});

describe("import de biblioteca en iOS", () => {
  function iosDeps(): { deps: IosLibraryImportDeps; log: SpinnerLog } {
    const { deps, log } = makeDeps();
    return { log, deps: { ...deps, reportSkipped: vi.fn() } };
  }

  it("informa del avance fichero a fichero mientras copia", async () => {
    vi.mocked(pickFilesViaWebView).mockResolvedValue([
      new File(["a"], "one.wav"),
      new File(["b"], "two.wav"),
    ]);
    vi.mocked(importStagedAudioFiles).mockResolvedValue({
      assets: [asset("one.wav"), asset("two.wav")],
      skipped: [],
    });
    const { deps, log } = iosDeps();

    await runIosLibraryImport(deps);

    // Nothing on the backend emits progress for this route, so a static
    // "Leyendo archivo…" is all the user would get for minutes. The counter has
    // to advance once per staged file.
    const staged = log.progress
      .filter((entry) => entry?.message.includes("importProgressStaging"))
      .map((entry) => entry?.percent);
    expect(staged).toEqual([0, 45, 90]);
    expect(log.importing).toEqual([true, false]);
  });

  it("no toca el indicador si el usuario cancela el selector", async () => {
    vi.mocked(pickFilesViaWebView).mockResolvedValue([]);
    const { deps, log } = iosDeps();

    await runIosLibraryImport(deps);

    expect(log.importing).toEqual([]);
    expect(vi.mocked(stageFileForImport)).not.toHaveBeenCalled();
  });
});
