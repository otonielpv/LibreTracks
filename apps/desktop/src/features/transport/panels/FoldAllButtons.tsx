import { useTranslation } from "react-i18next";

type FoldAllButtonsProps = {
  /** How many rows there are and how many are folded. */
  total: number;
  folded: number;
  onCollapseAll: () => void;
  onExpandAll: () => void;
};

/** "Collapse all" / "Expand all" over a list of editor rows (MIDI messages,
 * cue actions). Hidden with fewer than two rows: nothing to gain. */
export function FoldAllButtons({ total, folded, onCollapseAll, onExpandAll }: FoldAllButtonsProps) {
  const { t } = useTranslation();
  if (total < 2) return null;
  return (
    <div className="lt-fold-all-buttons">
      <button type="button" className="lt-secondary-button" disabled={folded >= total} onClick={onCollapseAll}>
        <span className="material-symbols-outlined" aria-hidden="true">unfold_less</span>
        {t("transport.editorFolds.collapseAll")}
      </button>
      <button type="button" className="lt-secondary-button" disabled={folded === 0} onClick={onExpandAll}>
        <span className="material-symbols-outlined" aria-hidden="true">unfold_more</span>
        {t("transport.editorFolds.expandAll")}
      </button>
    </div>
  );
}
