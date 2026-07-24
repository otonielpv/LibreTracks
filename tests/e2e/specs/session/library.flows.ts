import { browser, expect, $ } from "@wdio/globals";
import AppPage from "../../pageobjects/app.page.js";
import { UNUSED_AUDIO_FILE_NAME } from "./support.js";

export function registerSessionLibraryFlows() {
  it("organizes and removes library assets through virtual folders", async () => {
    await AppPage.openLibrary();
    await (await AppPage.libraryFolderButton).click();

    let input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Folder");
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () => (await AppPage.libraryState()).folders.includes("E2E Folder"),
      {
        timeout: 30_000,
        timeoutMsg: "The virtual folder was not created in the backend",
      },
    );

    let folderSummary = await $(
      '.lt-library-folder-summary[data-library-folder-path="E2E Folder"]',
    );
    const asset = await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME);
    await asset.dragAndDrop(folderSummary);
    await browser.waitUntil(
      async () =>
        (await AppPage.libraryState()).assets.find(
          (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
        )?.folderPath === "E2E Folder",
      {
        timeout: 30_000,
        timeoutMsg: "Dragging the asset did not move it into the virtual folder",
      },
    );

    await folderSummary.click({ button: "right" });
    let menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Renombrar carpeta")).click();

    input = await $("#lt-dialog-input");
    await input.waitForDisplayed();
    await input.click();
    await browser.keys(["Control", "a"]);
    await browser.keys("E2E Renamed Folder");
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () => {
        const state = await AppPage.libraryState();
        return (
          state.folders.includes("E2E Renamed Folder") &&
          !state.folders.includes("E2E Folder") &&
          state.assets.find(
            (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
          )?.folderPath === "E2E Renamed Folder"
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "Renaming the folder did not update its asset in the backend",
      },
    );

    const movedAsset = await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME);
    await movedAsset.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Mover a la raiz")).click();
    await browser.waitUntil(
      async () =>
        (await AppPage.libraryState()).assets.find(
          (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
        )?.folderPath == null,
      {
        timeout: 30_000,
        timeoutMsg: "Moving the asset to the library root did not persist",
      },
    );

    folderSummary = await $(
      '.lt-library-folder-summary[data-library-folder-path="E2E Renamed Folder"]',
    );
    await folderSummary.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button=Eliminar carpeta")).click();
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () =>
        !(await AppPage.libraryState()).folders.includes("E2E Renamed Folder"),
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the virtual folder did not persist",
      },
    );

    const rootAsset = await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME);
    await rootAsset.click({ button: "right" });
    menu = await $(".lt-context-menu");
    await menu.waitForDisplayed();
    await (await menu.$("button*=Borrar")).click();
    await (await $(".lt-dialog-button--primary")).click();
    await browser.waitUntil(
      async () =>
        !(await AppPage.libraryState()).assets.some(
          (candidate) => candidate.fileName === UNUSED_AUDIO_FILE_NAME,
        ),
      {
        timeout: 30_000,
        timeoutMsg: "Deleting the library asset did not persist",
      },
    );
    await expect(
      await AppPage.libraryAsset(UNUSED_AUDIO_FILE_NAME),
    ).not.toBeExisting();
  });
}
