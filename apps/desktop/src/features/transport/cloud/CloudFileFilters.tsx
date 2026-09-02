import { useTranslation } from "react-i18next";

import {
  availableKeys,
  availableTimeSignatures,
  hasActiveFilters,
  type CloudFileWithMeta,
  type CloudFilters,
} from "./cloudFileFilter";

/**
 * Search and filter controls for a cloud listing.
 *
 * Shared by the import picker and the storage manager, because looking for a
 * song is the same job whether you are about to import it or about to delete
 * it.
 *
 * The key and meter dropdowns are built from what is actually in the listing
 * rather than from every key that exists: offering twenty-four options when
 * three are present makes the control slower to use, not more capable.
 */

type CloudFileFiltersProps = {
  filters: CloudFilters;
  onChange: (filters: CloudFilters) => void;
  /** Every file in the folder, unfiltered, so the dropdowns stay stable. */
  all: CloudFileWithMeta[];
  /** How many survive the current filters, for the counter. */
  shownCount: number;
};

export function CloudFileFilters({
  filters,
  onChange,
  all,
  shownCount,
}: CloudFileFiltersProps) {
  const { t } = useTranslation();
  const keys = availableKeys(all);
  const meters = availableTimeSignatures(all);
  const active = hasActiveFilters(filters);

  // Nothing to filter and nothing typed: the controls would be noise above an
  // empty or one-line list.
  if (all.length === 0) {
    return null;
  }

  const parseBpm = (raw: string): number | null => {
    const value = Number(raw);
    return raw.trim() === "" || !Number.isFinite(value) ? null : value;
  };

  return (
    <div className="lt-cloud-filters">
      <input
        type="search"
        className="lt-cloud-filter-search"
        value={filters.search}
        placeholder={t("transport.cloud.searchPlaceholder", {
          defaultValue: "Buscar por nombre, tempo o tonalidad…",
        })}
        onChange={(event) => onChange({ ...filters, search: event.target.value })}
        aria-label={t("transport.cloud.searchLabel", { defaultValue: "Buscar" })}
      />

      <div className="lt-cloud-filter-row">
        {keys.length > 0 ? (
          <select
            value={filters.key}
            onChange={(event) => onChange({ ...filters, key: event.target.value })}
            aria-label={t("transport.cloud.filterKey", { defaultValue: "Tonalidad" })}
          >
            <option value="">
              {t("transport.cloud.anyKey", { defaultValue: "Cualquier tonalidad" })}
            </option>
            {keys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        ) : null}

        {meters.length > 0 ? (
          <select
            value={filters.timeSignature}
            onChange={(event) =>
              onChange({ ...filters, timeSignature: event.target.value })
            }
            aria-label={t("transport.cloud.filterMeter", { defaultValue: "Métrica" })}
          >
            <option value="">
              {t("transport.cloud.anyMeter", { defaultValue: "Cualquier métrica" })}
            </option>
            {meters.map((meter) => (
              <option key={meter} value={meter}>
                {meter}
              </option>
            ))}
          </select>
        ) : null}

        <span className="lt-cloud-filter-bpm">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={filters.bpmMin ?? ""}
            placeholder={t("transport.cloud.bpmMin", { defaultValue: "BPM mín" })}
            aria-label={t("transport.cloud.bpmMin", { defaultValue: "BPM mín" })}
            onChange={(event) =>
              onChange({ ...filters, bpmMin: parseBpm(event.target.value) })
            }
          />
          <span aria-hidden="true">–</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={filters.bpmMax ?? ""}
            placeholder={t("transport.cloud.bpmMax", { defaultValue: "máx" })}
            aria-label={t("transport.cloud.bpmMax", { defaultValue: "BPM máx" })}
            onChange={(event) =>
              onChange({ ...filters, bpmMax: parseBpm(event.target.value) })
            }
          />
        </span>

        {active ? (
          <button
            type="button"
            className="lt-link-button"
            onClick={() =>
              onChange({
                search: "",
                key: "",
                timeSignature: "",
                bpmMin: null,
                bpmMax: null,
              })
            }
          >
            {t("transport.cloud.clearFilters", { defaultValue: "Quitar filtros" })}
          </button>
        ) : null}
      </div>

      {active ? (
        <p className="lt-cloud-filter-count">
          {t("transport.cloud.filterCount", {
            defaultValue: "{{shown}} de {{total}}",
            shown: shownCount,
            total: all.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
