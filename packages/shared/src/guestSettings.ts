import type { AppSettings } from "./models";

export const GUEST_PREFERENCE_KEYS = [
  "locale",
  "timelineNavigationScheme",
  "timelinePlayheadFollowMode",
] as const satisfies readonly (keyof AppSettings)[];

export const GUEST_CONTROL_SETTING_KEYS = [
  "globalJumpMode",
  "globalJumpBars",
  "songJumpTrigger",
  "songJumpBars",
  "songTransitionMode",
  "vampMode",
  "vampBars",
  "pauseAtSongEnd",
  "vampBetweenSongs",
  "fadeOutStopSeconds",
] as const satisfies readonly (keyof AppSettings)[];

const GUEST_MIX_SETTING_KEYS = ["metronomeEnabled", "metronomeVolume", "trackMeterMode"] as const;
const HOST_SETTING_KEYS = [...GUEST_CONTROL_SETTING_KEYS, ...GUEST_MIX_SETTING_KEYS];

function copySetting<K extends keyof AppSettings>(
  target: AppSettings,
  source: AppSettings,
  key: K,
) {
  target[key] = source[key];
}

export function withGuestPreferences(host: AppSettings, local: AppSettings): AppSettings {
  const result = { ...host };
  for (const key of GUEST_PREFERENCE_KEYS) copySetting(result, local, key);
  return result;
}

type SettingsInvoke = (command: string, args?: Record<string, unknown>) => Promise<AppSettings>;

/** Split full-form saves into changed host settings and this device's preferences. */
export function createGuestSettingsBridge(
  local: SettingsInvoke,
  host: SettingsInvoke,
  canEdit: () => boolean,
) {
  let visible: AppSettings | null = null;
  let preferences: AppSettings | null = null;

  async function overlay(settings: AppSettings) {
    preferences ??= await local("get_settings");
    visible = withGuestPreferences(settings, preferences);
    return visible;
  }

  return {
    overlay,
    async read() {
      preferences = await local("get_settings");
      return overlay(await host("get_settings"));
    },
    async save(settings: AppSettings) {
      const previous = visible;
      if (!previous) throw new Error("guest:notConnected");
      const allowedKeys: readonly (keyof AppSettings)[] = [
        ...GUEST_PREFERENCE_KEYS,
        ...HOST_SETTING_KEYS,
      ];
      for (const key of Object.keys(settings) as (keyof AppSettings)[]) {
        if (!allowedKeys.includes(key) &&
            JSON.stringify(settings[key]) !== JSON.stringify(previous[key])) {
          throw new Error("guest:notAvailable");
        }
      }
      const hostKeys = HOST_SETTING_KEYS.filter((key) => settings[key] !== previous[key]);
      if (!canEdit() && hostKeys.some((key) => GUEST_MIX_SETTING_KEYS.some((mixKey) => mixKey === key))) {
        throw new Error("guest:forbidden");
      }
      let savedHost = await host("get_settings");
      if (hostKeys.length) {
        for (const key of hostKeys) copySetting(savedHost, settings, key);
        savedHost = await host("save_settings", { settings: savedHost });
      }
      const localKeys = GUEST_PREFERENCE_KEYS.filter((key) => settings[key] !== previous[key]);
      if (localKeys.length) {
        const nextLocal = await local("get_settings");
        for (const key of localKeys) copySetting(nextLocal, settings, key);
        preferences = await local("save_settings", { settings: nextLocal });
      }
      return overlay(savedHost);
    },
  };
}
