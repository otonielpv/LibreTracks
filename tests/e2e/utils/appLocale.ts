import { browser } from "@wdio/globals";

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;

/**
 * Puts the app in `language` for a capture run and returns how to undo it.
 *
 * The E2E app shares its settings file with the developer's own install (the
 * same identifier), so a run that switched the language and stopped there
 * would leave the real app in English. The previous value — usually unset,
 * "follow the system" — is what the returned function writes back.
 */
export async function useAppLocale(language: "es" | "en"): Promise<() => Promise<void>> {
  const previous = (await browser.execute(async (lang: string) => {
    const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
    const settings = (await invoke("get_settings")) as { locale?: string | null };
    const before = settings.locale ?? null;
    await invoke("save_settings", { settings: { ...settings, locale: lang } });
    return before;
  }, language)) as string | null;
  // The frontend picks the language up when it loads its settings.
  await browser.execute(() => window.location.reload());
  await browser.pause(6000);
  return async () => {
    await browser.execute(async (lang: string | null) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
      const settings = (await invoke("get_settings")) as Record<string, unknown>;
      await invoke("save_settings", { settings: { ...settings, locale: lang } });
    }, previous);
  };
}

/**
 * Sets the voice guide's language for a run and returns how to undo it. Goes
 * through update_audio_settings like the app's own popover: save_settings does
 * not reach the engine, which would keep announcing in the old language.
 */
export async function useVoiceGuideLanguage(language: "es" | "en"): Promise<() => Promise<void>> {
  const apply = async (lang: string) =>
    (await browser.execute(async (l: string) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__.invoke;
      const settings = (await invoke("get_settings")) as Record<string, unknown>;
      const before = settings.voiceGuideLanguage as string;
      await invoke("update_audio_settings", { settings: { ...settings, voiceGuideLanguage: l } });
      return before;
    }, lang)) as string;
  const previous = await apply(language);
  return async () => {
    await apply(previous);
  };
}
