import { LibraryModeField } from "../library/folders/LibraryModeField";
import { DecodingCacheField } from "./DecodingCacheField";
import { SessionStorageVolumeField } from "./SessionStorageVolumeField";
import { SettingsTabSection } from "./SettingsTabSection";

/**
 * Settings › Storage: where the library looks, where sessions live and the
 * decoding cache. A network guest only gets the cache, which is this machine's.
 */
export function StorageSettingsTab({ isGuest }: { isGuest: boolean }) {
  return (
    <SettingsTabSection id="storage">
      {!isGuest ? <LibraryModeField /> : null}
      {!isGuest ? <SessionStorageVolumeField /> : null}
      <DecodingCacheField />
    </SettingsTabSection>
  );
}
