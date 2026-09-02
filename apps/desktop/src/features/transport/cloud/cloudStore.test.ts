import { beforeEach, describe, expect, it } from "vitest";

import { newTransfer, useCloudStore } from "./cloudStore";

describe("progreso de transferencia de nube", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  function startAt(atMs: number) {
    const transfer = { ...newTransfer("set.ltset", "upload"), sampledAtMs: atMs };
    useCloudStore.setState({ transfer });
  }

  it("calcula la velocidad a partir de dos muestras", () => {
    startAt(1_000);
    // 10 MiB en 2 s = 5 MiB/s.
    useCloudStore.getState().setTransferProgress(10_485_760, 104_857_600, 3_000);

    const transfer = useCloudStore.getState().transfer;
    expect(transfer?.bytesPerSecond).toBeCloseTo(5_242_880, 0);
    // Quedan 90 MiB a 5 MiB/s = 18 s.
    expect(transfer?.etaSeconds).toBeCloseTo(18, 0);
    expect(transfer?.percent).toBe(10);
  });

  /// Sin esta guarda, dos eventos separados por milisegundos dan una velocidad
  /// disparatada (un delta minúsculo entre un intervalo minúsculo) y el tiempo
  /// restante salta de forma ilegible.
  it("ignora muestras demasiado seguidas para el calculo de velocidad", () => {
    startAt(1_000);
    useCloudStore.getState().setTransferProgress(1_000, 104_857_600, 1_050);

    const transfer = useCloudStore.getState().transfer;
    expect(transfer?.bytesPerSecond).toBeNull();
    expect(transfer?.etaSeconds).toBeNull();
    // Los totales sí avanzan aunque la velocidad no se recalcule.
    expect(transfer?.doneBytes).toBe(1_000);
  });

  it("suaviza en vez de saltar al ultimo valor instantaneo", () => {
    startAt(0);
    useCloudStore.getState().setTransferProgress(10_485_760, 104_857_600, 1_000);
    const first = useCloudStore.getState().transfer?.bytesPerSecond ?? 0;

    // Segundo tramo diez veces más lento: el valor mostrado debe moverse hacia
    // él, no reemplazarlo de golpe.
    useCloudStore.getState().setTransferProgress(11_534_336, 104_857_600, 2_000);
    const second = useCloudStore.getState().transfer?.bytesPerSecond ?? 0;

    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(1_048_576);
  });

  /// Un evento que llega justo después de terminar no debe resucitar la barra.
  it("descarta progreso sin transferencia en curso", () => {
    useCloudStore.setState({ transfer: null });
    useCloudStore.getState().setTransferProgress(50, 100, Date.now());
    expect(useCloudStore.getState().transfer).toBeNull();
  });

  it("no divide por cero con un total desconocido", () => {
    startAt(0);
    useCloudStore.getState().setTransferProgress(0, 0, 1_000);
    expect(useCloudStore.getState().transfer?.percent).toBe(0);
  });
});
