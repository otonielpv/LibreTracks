import { createContext, useContext } from "react";
import { create } from "zustand";

/**
 * Settings panels (metronome, voice guide, pads) fold down to their header,
 * which keeps the on/off switch: on a phone they are long, and once set up
 * they are mostly switched, not edited. Folded per widget instance and per
 * device (localStorage), like the rest of the remote's view preferences.
 */
const STORAGE_KEY = "libretracks.remote.collapsedWidgets";

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

type CollapsedStore = {
  collapsed: Set<string>;
  toggle: (id: string) => void;
};

export const useCollapsedWidgets = create<CollapsedStore>()((set) => ({
  collapsed: typeof window === "undefined" ? new Set() : readCollapsed(),
  toggle: (id) =>
    set((state) => {
      const next = new Set(state.collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Storage blocked: the fold lasts this session only.
      }
      return { collapsed: next };
    }),
}));

/** The layout widget a panel is rendered in (null outside the canvas). */
export const WidgetInstanceContext = createContext<string | null>(null);

export function useWidgetCollapsed(): { collapsible: boolean; collapsed: boolean; toggle: () => void } {
  const id = useContext(WidgetInstanceContext);
  const collapsed = useCollapsedWidgets((state) => (id ? state.collapsed.has(id) : false));
  const toggle = useCollapsedWidgets((state) => state.toggle);
  return { collapsible: id !== null, collapsed, toggle: () => (id ? toggle(id) : undefined) };
}

/** A panel's title; inside the canvas, the button that folds the panel. */
export function PanelTitle({ title, expandLabel, collapseLabel }: { title: string; expandLabel: string; collapseLabel: string }) {
  const { collapsible, collapsed, toggle } = useWidgetCollapsed();
  if (!collapsible) return <strong>{title}</strong>;
  return (
    <button
      type="button"
      className="panel-collapse-toggle"
      aria-expanded={!collapsed}
      title={collapsed ? expandLabel : collapseLabel}
      onClick={toggle}
    >
      <svg className="panel-collapse-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path d="M7 9.5 12 14.5 17 9.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <strong>{title}</strong>
    </button>
  );
}
