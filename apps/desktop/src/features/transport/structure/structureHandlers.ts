import type { TransportSnapshot } from "@libretracks/shared/models";
import type {
  ArrangementInput,
  SongStructureResult,
  StructureWarning,
  DroppedArrangementBlocks,
} from "@libretracks/shared/desktopApi";

import {
  applySongArrangement,
  captureSongStructure,
  deleteSongArrangement,
  discardSongStructure,
  saveSongArrangement,
} from "../desktopApi";
import { closeStructureGuard } from "./structureStore";

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
  /** Capture warnings and dropped blocks, shown by the editor. */
  onReport?: (report: StructureReport) => void;
};

export type StructureReport = {
  regionId: string;
  warnings: StructureWarning[];
  droppedBlocks: DroppedArrangementBlocks[];
};

export function createStructureHandlers(deps: StructureHandlerDeps) {
  const finish = (regionId: string, result: SongStructureResult) => {
    deps.applyPlaybackSnapshot(result.snapshot);
    deps.onReport?.({
      regionId,
      warnings: result.warnings,
      droppedBlocks: result.droppedBlocks,
    });
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
    ): Promise<boolean> {
      let ok = false;
      await deps.runAction(async () => {
        finish(regionId, await saveSongArrangement(regionId, arrangement, apply));
        if (apply) {
          deps.setStatus(
            deps.t("transport.structure.applied", { name: arrangement.name }),
          );
        }
        ok = true;
      });
      return ok;
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

    async discardStructure(regionId: string) {
      await deps.runAction(async () => {
        finish(regionId, await discardSongStructure(regionId));
      });
    },
  };
}

export type StructureHandlers = ReturnType<typeof createStructureHandlers>;
