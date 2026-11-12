import { TelemetrySettingsField } from "../../telemetry/TelemetryController";
import { SettingsTabSection } from "./SettingsTabSection";
import { UpdateCheckField } from "./UpdateCheckField";

/** Settings › System: update checks (desktop only) and anonymous telemetry. */
export function SystemSettingsTab() {
  return (
    <SettingsTabSection id="system">
      <UpdateCheckField />
      <TelemetrySettingsField />
    </SettingsTabSection>
  );
}
