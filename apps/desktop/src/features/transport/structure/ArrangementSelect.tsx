import { selectionOf } from "./structureEditor";
import { ORIGINAL_SELECTION } from "./structureStore";
import type { ArrangementActions } from "./useArrangementActions";

/** Saved-arrangement picker, shared by both layouts. */
export function ArrangementSelect({ actions }: { actions: ArrangementActions }) {
  const { t, draft, structure, appliedId } = actions;
  if (!draft || !structure) return null;
  return (
    <label className="lt-structure-select">
      <span>{t("transport.structure.selector")}</span>
      <select
        value={selectionOf(draft)}
        onChange={(event) => void actions.switchTo(event.target.value)}
      >
        {/* The original is one more choice, always there and not deletable. */}
        <option value={ORIGINAL_SELECTION}>
          {appliedId === null
            ? `${t("transport.structure.original")} · ${t("transport.structure.appliedBadge")}`
            : t("transport.structure.original")}
        </option>
        {draft.arrangementId === null && !draft.isOriginal ? (
          <option value="">{draft.name}</option>
        ) : null}
        {structure.arrangements.map((arrangement) => (
          <option key={arrangement.id} value={arrangement.id}>
            {arrangement.id === appliedId
              ? `${arrangement.name} · ${t("transport.structure.appliedBadge")}`
              : arrangement.name}
          </option>
        ))}
      </select>
    </label>
  );
}
