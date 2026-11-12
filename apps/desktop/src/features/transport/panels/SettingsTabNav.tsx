import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { SettingsTab, SettingsTabGroup } from "../types";

export type SettingsTabItem = {
  id: SettingsTab;
  label: string;
  /** Tabs sharing a group fold under one expandable row in the sidebar. */
  group?: SettingsTabGroup;
};

type Props = {
  tabs: SettingsTabItem[];
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
};

type NavEntry =
  | { kind: "tab"; tab: SettingsTabItem }
  | { kind: "group"; group: SettingsTabGroup; tabs: SettingsTabItem[] };

/**
 * Consecutive tabs of the same group become one entry. A group left with a
 * single visible tab (a guest, a phone without MIDI) is shown as that tab: a
 * fold with one child is just an extra tap.
 */
function buildEntries(tabs: SettingsTabItem[]): NavEntry[] {
  const entries: NavEntry[] = [];
  for (const tab of tabs) {
    const last = entries[entries.length - 1];
    if (tab.group && last?.kind === "group" && last.group === tab.group) {
      last.tabs.push(tab);
    } else if (tab.group) {
      entries.push({ kind: "group", group: tab.group, tabs: [tab] });
    } else {
      entries.push({ kind: "tab", tab });
    }
  }
  return entries.map((entry) =>
    entry.kind === "group" && entry.tabs.length === 1
      ? { kind: "tab", tab: entry.tabs[0] }
      : entry,
  );
}

/** The sidebar row a group folds under ("General", "MIDI"). */
export function settingsGroupLabel(t: TFunction, group: SettingsTabGroup): string {
  return group === "midi"
    ? t("transport.settingsModal.tabMidi", { defaultValue: "MIDI" })
    : t("transport.settingsModal.tabGeneral", { defaultValue: "General" });
}

function groupOf(tabs: SettingsTabItem[], id: SettingsTab): SettingsTabGroup | null {
  return tabs.find((tab) => tab.id === id)?.group ?? null;
}

/**
 * The Settings sidebar. Each group opens and closes on its own (opening one
 * never folds another) and the list scrolls when it outgrows a short screen.
 * Opening a group shows its first tab, so tapping "General" lands on settings
 * rather than on an empty fold; the group holding the active tab opens by
 * itself when something else (a menu, a shortcut) jumps to that tab.
 */
export function SettingsTabNav({ tabs, activeTab, onTabChange }: Props) {
  const { t } = useTranslation();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<SettingsTabGroup>>(() => {
    const group = groupOf(tabs, activeTab);
    return new Set(group ? [group] : []);
  });
  const setGroupOpen = useCallback((group: SettingsTabGroup, open: boolean) =>
    setOpenGroups((current) => {
      if (current.has(group) === open) return current;
      const next = new Set(current);
      if (open) next.add(group);
      else next.delete(group);
      return next;
    }), []);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const group = groupOf(tabs, activeTab);
    if (group) setGroupOpen(group, true);
  }, [tabs, activeTab, setGroupOpen]);

  // The list scrolls on short screens: keep the selected tab in sight.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(".lt-settings-tab-button.is-active");
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeTab, openGroups]);

  const groupLabel = (group: SettingsTabGroup) => settingsGroupLabel(t, group);

  const tabButton = (tab: SettingsTabItem, sub = false) => {
    const isActive = activeTab === tab.id;
    return (
      <button
        key={tab.id}
        type="button"
        role="tab"
        id={`lt-settings-tab-${tab.id}`}
        className={`lt-settings-tab-button${sub ? " lt-settings-tab-button--sub" : ""}${isActive ? " is-active" : ""}`}
        aria-selected={isActive}
        aria-controls={`lt-settings-panel-${tab.id}`}
        onClick={() => onTabChange(tab.id)}
      >
        {tab.label}
      </button>
    );
  };

  return (
    <div
      ref={listRef}
      className="lt-settings-tablist"
      role="tablist"
      aria-orientation="vertical"
      aria-label={t("transport.settingsModal.tabListLabel", {
        defaultValue: "Settings sections",
      })}
    >
      {buildEntries(tabs).map((entry) => {
        if (entry.kind === "tab") return tabButton(entry.tab);
        const isOpen = openGroups.has(entry.group);
        const holdsActive = entry.tabs.some((tab) => tab.id === activeTab);
        return (
          <div
            key={`group-${entry.group}`}
            className={`lt-settings-tab-group${isOpen ? " is-open" : ""}`}
            role="presentation"
          >
            <button
              type="button"
              id={`lt-settings-group-${entry.group}`}
              className={`lt-settings-tab-button lt-settings-tab-group-toggle${holdsActive ? " holds-active" : ""}`}
              aria-expanded={isOpen}
              aria-controls={`lt-settings-group-items-${entry.group}`}
              data-lt-settings-group-tabs={entry.tabs.map((tab) => tab.id).join(" ")}
              onClick={() => {
                if (isOpen) {
                  setGroupOpen(entry.group, false);
                  return;
                }
                setGroupOpen(entry.group, true);
                if (!holdsActive) onTabChange(entry.tabs[0].id);
              }}
            >
              <span>{groupLabel(entry.group)}</span>
              <span className="material-symbols-outlined" aria-hidden="true">
                chevron_right
              </span>
            </button>
            {isOpen ? (
              <div
                id={`lt-settings-group-items-${entry.group}`}
                className="lt-settings-tab-group-items"
                role="presentation"
              >
                {entry.tabs.map((tab) => tabButton(tab, true))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
