import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryAssetSummary,
  LibraryImportProgressEvent,
} from "@libretracks/shared/models";
import {
  runAndroidLibraryImport,
  runIosLibraryImport,
  type MobileLibraryImportDeps,
} from "./mobileLibraryImport";
import {
  createClipsWithAutoTracks,
  importPickedLibraryAudio,
  importStagedAudioFiles,
  pickLibraryAudioDocuments,
} from "../desktopApi";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import { pickFilesViaWebView, stageFileForImport } from "./mobileFilePicker";
import { useTransportStore } from "../store";

vi.mock("../desktopApi", () => ({
  createClipsWithAutoTracks: vi.fn(async () => ({})),
  pickLibraryAudioDocuments: vi.fn(async () => ({
    batchId: "",
    fileNames: [],
  })),
  importPickedLibraryAudio: vi.fn(async () => ({ assets: [], skipped: [] })),
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

function makeDeps(): {
  deps: MobileLibraryImportDeps;
  log: SpinnerLog;
} {
  const log: SpinnerLog = { importing: [], progress: [] };
  return {
    log,
    deps: {
      t: (key, options) => `${key}${options ? JSON.stringify(options) : ""}`,
      setStatus: vi.fn(),
      mergeLibraryAssets: vi.fn(),
      refreshLibraryState: vi.fn(async () => undefined),
      applyPlaybackSnapshot: vi.fn(),
      getImportPositionSeconds: () => 0,
      setIsImportingLibrary: (importing) => log.importing.push(importing),
      setLibraryImportProgress: (progress) => log.progress.push(progress),
      reportSkipped: vi.fn(),
    },
  };
}

function pickedBatch(...fileNames: string[]) {
  return { batchId: "batch-1", fileNames };
}

function pendingNames(): string[] {
  return useTransportStore
    .getState()
    .pendingAudioImports.map((item) => item.fileName);
}

beforeEach(() => {
  vi.clearAllMocks();
  useTransportStore.setState({ pendingAudioImports: [] });
});

describe("import de biblioteca en Android", () => {
  it("muestra un marcador por fichero en cuanto se eligen, antes de copiar", async () => {
    vi.mocked(pickLibraryAudioDocuments).mockResolvedValue(
      pickedBatch("bass.wav", "drums.wav"),
    );
    let namesWhileImporting: string[] = [];
    vi.mocked(importPickedLibraryAudio).mockImplementation(async () => {
      // Snapshot mid-import: this is the window the user stares at, and the one
      // that showed an empty library before the picker was split in two.
      namesWhileImporting = pendingNames();
      return { assets: [asset("bass.wav"), asset("drums.wav")], skipped: [] };
    });
    const { deps } = makeDeps();

    await runAndroidLibraryImport(deps);

    expect(namesWhileImporting).toEqual(["bass.wav", "drums.wav"]);
  });

  it("reclama el lote que dejo el selector", async () => {
    vi.mocked(pickLibraryAudioDocuments).mockResolvedValue(
      pickedBatch("bass.wav"),
    );
    const { deps } = makeDeps();

    await runAndroidLibraryImport(deps);

    expect(vi.mocked(importPickedLibraryAudio)).toHaveBeenCalledWith("batch-1");
  });

  it("enciende el indicador mientras importa y lo apaga al terminar", async () => {
    vi.mocked(pickLibraryAudioDocuments).mockResolvedValue(
      pickedBatch("bass.wav"),
    );
    const { deps, log } = makeDeps();

    await runAndroidLibraryImport(deps);

    expect(log.importing).toEqual([true, false]);
  });

  it("no toca el indicador ni crea marcadores si se cancela el selector", async () => {
    vi.mocked(pickLibraryAudioDocuments).mockResolvedValue(pickedBatch());
    const { deps, log } = makeDeps();

    await runAndroidLibraryImport(deps);

    expect(log.importing).toEqual([]);
    expect(pendingNames()).toEqual([]);
    expect(vi.mocked(importPickedLibraryAudio)).not.toHaveBeenCalled();
  });

  it("apaga el indicador cuando el import falla", async () => {
    vi.mocked(pickLibraryAudioDocuments).mockResolvedValue(
      pickedBatch("bass.wav"),
    );
    vi.mocked(importPickedLibraryAudio).mockRejectedValue(
      new Error("no se pudo leer"),
    );
    const { deps, log } = makeDeps();

    await runAndroidLibraryImport(deps);

    // A spinner left spinning after a failure is worse than no spinner: the
    // panel would look busy forever and the import button stays disabled.
    expect(log.importing).toEqual([true, false]);
  });

  it("ofrece llevar al timeline lo que acaba de entrar", async () => {
    vi.mocked(pickLibraryAudioDocuments).mockResolvedValue(
      pickedBatch("new.wav"),
    );
    vi.mocked(importPickedLibraryAudio).mockResolvedValue({
      assets: [asset("new.wav")],
      skipped: [],
    });
    const { deps } = makeDeps();

    await runAndroidLibraryImport(deps);

    expect(vi.mocked(confirmDialog)).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(confirmDialog).mock.calls[0][0] as string;
    expect(prompt).toContain('"count":1');
    // The prompt was declined by the default mock, so nothing is placed.
    expect(vi.mocked(createClipsWithAutoTracks)).not.toHaveBeenCalled();
  });
});

describe("import de biblioteca en iOS", () => {
  function iosDeps(): { deps: MobileLibraryImportDeps; log: SpinnerLog } {
    return makeDeps();
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
