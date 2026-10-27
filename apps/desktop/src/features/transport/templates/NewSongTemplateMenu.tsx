import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { BUILTIN_BAND_TEMPLATE, NO_SONG_TEMPLATE } from "../desktopApi";
import { useSongTemplateList } from "../hooks/useSongTemplateList";
import { PopoverShell } from "../panels/PopoverShell";

/**
 * The arrow next to «+ Nueva canción»: create the next song from a template
 * picked here instead of the default one in Settings — or, with «Sin
 * plantilla», empty even when there is a default.
 */
export function NewSongTemplateMenu({
  onCreate,
}: {
  onCreate: (templateReference: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const { templates } = useSongTemplateList(open);

  const choose = (reference: string) => {
    setOpen(false);
    onCreate(reference);
  };

  return (
    <div className="lt-new-song-template">
      <button
        ref={anchorRef}
        type="button"
        className="lt-compact-view-add-song lt-new-song-template-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("songTemplates.newSongFromTemplate")}
        title={t("songTemplates.newSongFromTemplate")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          arrow_drop_down
        </span>
      </button>
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        ariaLabel={t("songTemplates.newSongFromTemplate")}
        onClose={() => setOpen(false)}
        className="lt-new-song-template-menu"
        role="menu"
      >
          <button type="button" role="menuitem" onClick={() => choose(NO_SONG_TEMPLATE)}>
            {t("songTemplates.noTemplate")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(BUILTIN_BAND_TEMPLATE)}
          >
            {t("songTemplates.builtinBand")}
          </button>
          {templates.map((template) => (
            <button
              key={template.path}
              type="button"
              role="menuitem"
              title={template.path}
              onClick={() => choose(template.path)}
            >
              {template.name}
            </button>
          ))}
      </PopoverShell>
    </div>
  );
}
