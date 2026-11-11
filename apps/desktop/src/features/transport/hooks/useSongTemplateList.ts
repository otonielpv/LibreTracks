import { useEffect, useState } from "react";

import { listSessionTemplates } from "../desktopApi";
import { useTemplateCatalogStore } from "../templates/templateCatalogStore";

export type SongTemplateSummary = { name: string; path: string };

/**
 * The `.lttemplate` files in the templates folder, for the places that let the
 * user pick a song template (Settings, «Nueva canción desde plantilla»).
 *
 * Loaded when `enabled` turns true and again every time it does, so a
 * template saved a moment ago shows up the next time the picker opens, and
 * again whenever a template is imported or saved while it is on screen. A
 * failed scan is an empty list: the built-in template is always offered
 * separately, so the picker is never empty.
 */
export function useSongTemplateList(enabled: boolean): {
  templates: SongTemplateSummary[];
  loading: boolean;
} {
  const [templates, setTemplates] = useState<SongTemplateSummary[]>([]);
  // Starts loading when enabled from the first render, so nobody reads the
  // empty list before the first scan as "there are no templates".
  const [loading, setLoading] = useState(enabled);
  const catalogVersion = useTemplateCatalogStore((state) => state.version);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listSessionTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, catalogVersion]);

  return { templates, loading };
}
