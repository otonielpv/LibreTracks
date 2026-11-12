import type { ReactNode } from "react";
import type { SettingsTab } from "../types";

/**
 * The tabpanel shell every simple Settings tab shares: the ids the tab buttons
 * point at (`lt-settings-tab-<id>` / `lt-settings-panel-<id>`, which the E2E
 * page objects address) and the field grid.
 */
export function SettingsTabSection({
  id,
  children,
}: {
  id: SettingsTab;
  children: ReactNode;
}) {
  return (
    <section
      className="lt-settings-tab-panel"
      role="tabpanel"
      id={`lt-settings-panel-${id}`}
      aria-labelledby={`lt-settings-tab-${id}`}
    >
      <div className="lt-settings-section-grid">{children}</div>
    </section>
  );
}
