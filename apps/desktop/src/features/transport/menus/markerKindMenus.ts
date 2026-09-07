import type { MarkerKind, SectionMarkerSummary } from "../desktopApi";
import { createSectionMarker, setSectionMarkerKind } from "../desktopApi";
import {
  availableCueKinds,
  availableSectionKinds,
  markerKindCategory,
  markerKindColor,
  markerKindLabel,
  markerKindVariants,
} from "../markerKinds";
import { formatClock } from "../helpers";
import type { TimelineMenuDeps } from "./timelineMenus";

/**
 * Todo lo que tiene que ver con el TIPO de una marca: crear una ya tipificada
 * y cambiarle el tipo a una que ya existe.
 *
 * Sale de `timelineMenus.ts` por tamano —el fichero tocaba su presupuesto— y
 * porque es un bloque con frontera limpia: solo necesita las dependencias
 * comunes y el desplazador de la posicion del menu. Mismo patron que
 * `midiMenus.ts`.
 *
 * El vocabulario es largo a proposito: 22 tipos de seccion, 13 de aviso y
 * variantes numeradas. Es lo que da sentido a la vista DAW, que se nutre de
 * las marcas.
 */
export function createMarkerKindMenus(
  getDeps: () => TimelineMenuDeps,
  bumpContextMenuPosition: () => { x: number; y: number },
) {
  function applyMarkerKind(
    section: SectionMarkerSummary,
    kind: MarkerKind,
    variant: number | null,
  ) {
    const d = getDeps();
    const { t } = d;
    void d.runAction(async () => {
      const nextSnapshot = await setSectionMarkerKind(section.id, kind, variant);
      d.applyPlaybackSnapshot(nextSnapshot);
      const kindLabel = markerKindLabel(kind, t);
      d.setStatus(
        t("transport.status.markerKindSet", {
          name: section.name,
          kind: variant ? `${kindLabel} ${variant}` : kindLabel,
        }),
      );
    });
  }

  // Create a new marker already typed and named after its kind. A null kind
  // creates an untyped (Custom) marker with the backend's generic name.
  function createTypedMarker(
    positionSeconds: number,
    kind: MarkerKind | null,
    variant: number | null,
  ) {
    const d = getDeps();
    const { t } = d;
    void d.runAction(async () => {
      const name =
        kind && kind !== "custom"
          ? variant
            ? `${markerKindLabel(kind, t)} ${variant}`
            : markerKindLabel(kind, t)
          : undefined;
      const nextSnapshot = await createSectionMarker(positionSeconds, {
        kind: kind ?? undefined,
        variant,
        name,
      });
      d.applyPlaybackSnapshot(nextSnapshot);
      d.clearSelection();
      d.setSelectedRegionId(null);
      d.setSelectedTimelineRange(null);
      d.setStatus(
        t("transport.status.markerCreatedAt", {
          time: formatClock(positionSeconds),
        }),
      );
    });
  }

  // Variant chooser used when creating a numbered section (Verse 1-6, ...).
  function openCreateMarkerVariantMenu(
    positionSeconds: number,
    kind: MarkerKind,
  ) {
    const d = getDeps();
    const variants = markerKindVariants(kind);
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: markerKindLabel(kind, d.t),
      actions: [
        {
          label: markerKindLabel(kind, d.t),
          swatch: markerKindColor(kind),
          onSelect: () => createTypedMarker(positionSeconds, kind, null),
        },
        ...variants.map((n) => ({
          label: `${markerKindLabel(kind, d.t)} ${n}`,
          swatch: markerKindColor(kind),
          onSelect: () => createTypedMarker(positionSeconds, kind, n),
        })),
      ],
    });
  }

  // Submenu listing section or cue kinds to create a new marker of that type.
  function openCreateMarkerKindList(
    positionSeconds: number,
    kinds: readonly MarkerKind[],
    title: string,
  ) {
    const d = getDeps();
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title,
      actions: kinds.map((kind) => {
        const hasVariants = markerKindVariants(kind).length > 0;
        return {
          label: `${markerKindLabel(kind, d.t)}${hasVariants ? " ▸" : ""}`,
          swatch: markerKindColor(kind),
          onSelect: () =>
            hasVariants
              ? openCreateMarkerVariantMenu(positionSeconds, kind)
              : createTypedMarker(positionSeconds, kind, null),
        };
      }),
    });
  }

  // Top-level chooser shown when creating a marker: Section / Cue / Custom.
  function openCreateMarkerKindMenu(positionSeconds: number) {
    const d = getDeps();
    const { t } = d;
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: t("transport.menu.createMarker"),
      actions: [
        {
          label: `${t("transport.menu.markerKindSectionsGroup")} ▸`,
          onSelect: () =>
            openCreateMarkerKindList(
              positionSeconds,
              availableSectionKinds().filter((kind) => kind !== "custom"),
              t("transport.menu.markerKindSectionsGroup"),
            ),
        },
        {
          label: `${t("transport.menu.markerKindCuesGroup")} ▸`,
          onSelect: () =>
            openCreateMarkerKindList(
              positionSeconds,
              availableCueKinds(d.appSettings.voiceGuideLanguage),
              t("transport.menu.markerKindCuesGroup"),
            ),
        },
        {
          label: markerKindLabel("custom", t),
          swatch: markerKindColor("custom"),
          onSelect: () => createTypedMarker(positionSeconds, null, null),
        },
      ],
    });
  }

  // Entradas directas a cada lista de tipos, sin pasar por el selector de
  // grupo. La barra tactil ya distingue "+ Seccion" de "+ Aviso", asi que
  // preguntar otra vez a cual de los dos grupos pertenece sobra.
  function openCreateSectionKindMenu(positionSeconds: number) {
    const d = getDeps();
    openCreateMarkerKindList(
      positionSeconds,
      availableSectionKinds().filter((kind) => kind !== "custom"),
      d.t("transport.menu.markerKindSectionsGroup"),
    );
  }

  function openCreateCueKindMenu(positionSeconds: number) {
    const d = getDeps();
    openCreateMarkerKindList(
      positionSeconds,
      availableCueKinds(d.appSettings.voiceGuideLanguage),
      d.t("transport.menu.markerKindCuesGroup"),
    );
  }

  // Variant chooser for kinds that ship numbered recordings (Verse 1-6, ...).
  function openMarkerVariantMenu(
    section: SectionMarkerSummary,
    kind: MarkerKind,
  ) {
    const d = getDeps();
    const variants = markerKindVariants(kind);
    const current = section.kind === kind ? (section.variant ?? null) : null;
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: markerKindLabel(kind, d.t),
      actions: [
        {
          label: `${markerKindLabel(kind, d.t)}${current == null ? " ✓" : ""}`,
          swatch: markerKindColor(kind),
          onSelect: () => applyMarkerKind(section, kind, null),
        },
        ...variants.map((n) => ({
          label: `${markerKindLabel(kind, d.t)} ${n}${current === n ? " ✓" : ""}`,
          swatch: markerKindColor(kind),
          onSelect: () => applyMarkerKind(section, kind, n),
        })),
      ],
    });
  }

  // Submenu listing a set of kinds (sections or cues). Sections may open a
  // further variant submenu; cues apply directly (no numbered variants).
  function openMarkerKindList(
    section: SectionMarkerSummary,
    kinds: readonly MarkerKind[],
    title: string,
  ) {
    const d = getDeps();
    const currentKind = section.kind ?? "custom";
    const next = bumpContextMenuPosition();
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title,
      actions: kinds.map((kind) => {
        const hasVariants = markerKindVariants(kind).length > 0;
        return {
          label: `${markerKindLabel(kind, d.t)}${hasVariants ? " ▸" : ""}${
            kind === currentKind ? " ✓" : ""
          }`,
          swatch: markerKindColor(kind),
          onSelect: () =>
            hasVariants
              ? openMarkerVariantMenu(section, kind)
              : applyMarkerKind(section, kind, null),
        };
      }),
    });
  }

  function openMarkerKindMenu(section: SectionMarkerSummary) {
    const d = getDeps();
    const { t } = d;
    const currentKind = section.kind ?? "custom";
    const currentIsCue = markerKindCategory(currentKind) === "cue";
    const next = bumpContextMenuPosition();
    // Top level splits the long vocabulary into Sections vs Cues (Playback-style
    // "dynamic cues"), each opening its own list. A ✓ marks which group the
    // marker currently belongs to.
    d.setContextMenu({
      x: next.x,
      y: next.y,
      title: t("transport.menu.markerKind"),
      actions: [
        {
          label: `${t("transport.menu.markerKindSectionsGroup")} ▸${
            currentIsCue ? "" : " ✓"
          }`,
          onSelect: () =>
            openMarkerKindList(
              section,
              availableSectionKinds(),
              t("transport.menu.markerKindSectionsGroup"),
            ),
        },
        {
          label: `${t("transport.menu.markerKindCuesGroup")} ▸${
            currentIsCue ? " ✓" : ""
          }`,
          onSelect: () =>
            openMarkerKindList(
              section,
              availableCueKinds(d.appSettings.voiceGuideLanguage),
              t("transport.menu.markerKindCuesGroup"),
            ),
        },
      ],
    });
  }

  return {
    createTypedMarker,
    openCreateMarkerKindMenu,
    openCreateSectionKindMenu,
    openCreateCueKindMenu,
    openMarkerKindMenu,
  };
}
