import {
  importSessionTemplateFrom,
  pickAndImportSessionTemplate,
  saveSessionAsTemplate,
  saveSessionAsTemplateAt,
  type SessionTemplateSummary,
} from "../desktopApi";
import { chooseStorage, finishExportWithChoice, importWithStorageChoice } from "../cloud/cloudFlows";
import { isCloudTarget, useCloudStore } from "../cloud/cloudStore";
import { useTemplateCatalogStore } from "./templateCatalogStore";

export { useTemplateCatalogStore };

/**
 * Moving `.lttemplate` files in and out of the templates folder: from another
 * computer, from the cloud, and up to the cloud.
 *
 * The templates folder stays the single place the app reads templates from.
 * Importing copies a template into it and uploading reads from it, so a
 * template from the cloud behaves exactly like one saved on this machine.
 */

/** `Mi banda` → `Mi banda.lttemplate`, with what a file name cannot hold replaced. */
export function templateFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, "-").trim() || "Plantilla";
  return `${safe}.lttemplate`;
}

/**
 * «Importar plantilla…»: ask «este equipo o la nube», bring the template into
 * the templates folder and return how it is listed. Null if the user backed
 * out anywhere along the way.
 */
export async function importTemplateWithChoice(): Promise<SessionTemplateSummary | null> {
  let imported: SessionTemplateSummary | null = null;
  await importWithStorageChoice(
    "template",
    async () => {
      imported = await pickAndImportSessionTemplate();
    },
    async (localPath) => {
      // Awaited: the staged download is deleted as soon as this resolves.
      imported = await importSessionTemplateFrom(localPath);
    },
  );
  if (imported) {
    useTemplateCatalogStore.getState().bump();
  }
  return imported;
}

/**
 * Upload a template that is already in the templates folder. Only asks which
 * account: «este equipo» makes no sense for a file that is already here.
 * Resolves true once it is up.
 */
export async function uploadTemplateToCloud(template: SessionTemplateSummary): Promise<boolean> {
  const choice = await chooseStorage("export", "template", { cloudOnly: true });
  if (!isCloudTarget(choice)) {
    return false;
  }
  const store = useCloudStore.getState();
  store.setProvider(choice);
  return (await store.upload(template.path)) !== null;
}

/**
 * «Guardar como plantilla…» with «este equipo o la nube» in front.
 *
 * - This device: the save dialog the menu always opened.
 * - Cloud: written to the staging folder, copied into the templates folder (so
 *   it is usable here too, like any saved template) and uploaded from there.
 *
 * Resolves true when the template was saved, false when the user backed out.
 */
export async function saveTemplateWithChoice(title: string): Promise<boolean> {
  const choice = await chooseStorage("export", "template");
  if (!choice) {
    return false;
  }
  if (!isCloudTarget(choice)) {
    const saved = await saveSessionAsTemplate();
    if (saved) {
      useTemplateCatalogStore.getState().bump();
    }
    return saved;
  }

  let saved = false;
  useCloudStore.getState().setExportTarget(choice);
  await finishExportWithChoice(templateFileName(title), async (writePath) => {
    if (!writePath) {
      return;
    }
    await saveSessionAsTemplateAt(writePath);
    await importSessionTemplateFrom(writePath);
    saved = true;
  });
  if (saved) {
    useTemplateCatalogStore.getState().bump();
  }
  return saved;
}
