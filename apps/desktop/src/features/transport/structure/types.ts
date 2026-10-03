// Arreglos de canción (reordenar, repetir y quitar secciones). Los tipos del
// resumen que manda el backend viven en `@libretracks/shared` junto a
// `SongRegionSummary`; se reexportan aquí para que el módulo `structure/` tenga
// un único punto de entrada.
export type {
  ArrangementBlockSummary,
  ArrangementSummary,
  SongStructureSummary,
  StructureSectionSummary,
} from "@libretracks/shared/models";
