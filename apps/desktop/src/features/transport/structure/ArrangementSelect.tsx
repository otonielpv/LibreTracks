import type { ArrangementActions } from "./useArrangementActions";

/** Saved-arrangement picker, shared by both layouts. */
export function ArrangementSelect({ actions }: { actions: ArrangementActions }) {
  const { t, draft, structure, appliedId } = actions;
  if (!draft || !structure) return null;
  return (
    <label className="lt-structure-select">
      <span>{t("transport.structure.selector")}</span>
      <select
        value={draft.arrangementId ?? ""}
        onChange={(event) => void actions.switchTo(event.target.value)}
      >
        {draft.arrangementId === null ? <option value="">{draft.name}</option> : null}
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
