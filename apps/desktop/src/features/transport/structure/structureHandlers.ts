import type { TransportSnapshot } from "@libretracks/shared/models";
import type {
  ArrangementInput,
  SongStructureResult,
} from "@libretracks/shared/desktopApi";

import {
  applySongArrangement,
  captureSongStructure,
  deleteSongArrangement,
  discardSongStructure,
  saveSongArrangement,
  updateSectionMarker,
} from "../desktopApi";
import { closeStructureGuard, useStructureStore } from "./structureStore";

/**
 * Song-arrangement actions ("Arreglo"), as a factory with injected
 * dependencies — instantiated once with `useMemo` like the other
 * `create*Handlers` in the transport panel. Everything volatile is read when
 * the action runs, so the factory never needs to be rebuilt.
 */
export type StructureHandlerDeps = {
  runAction: (work: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export function createStructureHandlers(deps: StructureHandlerDeps) {
  const finish = (regionId: string, result: SongStructureResult) => {
    deps.applyPlaybackSnapshot(result.snapshot);
    // A command that captured (or recaptured) reports what the editor should
    // show; one that did not leaves the previous report alone.
    if (result.warnings.length > 0 || result.droppedBlocks.length > 0) {
      useStructureStore.setState({
        report: { regionId, warnings: result.warnings, droppedBlocks: result.droppedBlocks },
      });
    }
    for (const dropped of result.droppedBlocks) {
      deps.setStatus(
        deps.t(
          dropped.arrangementRemoved
            ? "transport.structure.droppedRemoved"
            : "transport.structure.dropped",
          {
            sections: dropped.sectionNames.map((name) => `«${name}»`).join(", "),
            arrangement: dropped.arrangementName,
          },
        ),
      );
    }
  };

  return {
    /** "Edit original" from the guard dialog: go back to the original so the
     * user can edit freely; the arrangement is kept. */
    async editOriginal(regionId: string) {
      closeStructureGuard();
      await deps.runAction(async () => {
        finish(regionId, await applySongArrangement(regionId, null));
        deps.setStatus(deps.t("transport.structure.backToOriginal"));
      });
    },

    async captureOriginal(regionId: string) {
      await deps.runAction(async () => {
        useStructureStore.setState({ report: null });
        finish(regionId, await captureSongStructure(regionId));
        deps.setStatus(deps.t("transport.structure.captured"));
      });
    },

    /** Save an arrangement and, with `apply`, write it on the timeline in the
     * same backend command (one undo step). */
    async saveArrangement(
      regionId: string,
      arrangement: ArrangementInput,
      apply: boolean,
    ): Promise<{ ok: boolean; error: unknown }> {
      // The error is also handed back: on mobile the editor covers the status
      // bar where `runAction` reports it, so "Apply" seemed to do nothing.
      let ok = false;
      let failure: unknown = null;
      await deps.runAction(async () => {
        try {
          finish(regionId, await saveSongArrangement(regionId, arrangement, apply));
        } catch (error) {
          failure = error;
          throw error;
        }
        if (apply) {
          deps.setStatus(
            deps.t("transport.structure.applied", { name: arrangement.name }),
          );
        }
        ok = true;
      });
      return { ok, error: failure };
    },

    async applyArrangement(regionId: string, arrangementId: string | null, name?: string) {
      await deps.runAction(async () => {
        finish(regionId, await applySongArrangement(regionId, arrangementId));
        deps.setStatus(
          arrangementId
            ? deps.t("transport.structure.applied", { name: name ?? arrangementId })
            : deps.t("transport.structure.backToOriginal"),
        );
      });
    },

    async deleteArrangement(regionId: string, arrangementId: string) {
      await deps.runAction(async () => {
        finish(regionId, await deleteSongArrangement(regionId, arrangementId));
      });
    },

    /** "Snap to bar" on an off-beat warning: move the marker to the nearest
     * downbeat and capture the original again. */
    async snapSectionToBar(
      regionId: string,
      marker: { id: string; name: string },
      viewSeconds: number,
    ) {
      await deps.runAction(async () => {
        deps.applyPlaybackSnapshot(
          await updateSectionMarker(marker.id, marker.name, viewSeconds),
        );
        useStructureStore.setState({ report: null });
        finish(regionId, await captureSongStructure(regionId));
      });
    },

    async discardStructure(regionId: string) {
      await deps.runAction(async () => {
        finish(regionId, await discardSongStructure(regionId));
      });
    },
  };
}

export type StructureHandlers = ReturnType<typeof createStructureHandlers>;
