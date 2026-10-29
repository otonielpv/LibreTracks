import type { ContextMenuAction } from "../types";

/** Lists `actions` under the heading `title` (see ContextMenuAction.section). */
export function menuSection(
  title: string,
  actions: readonly ContextMenuAction[],
): ContextMenuAction[] {
  return actions.map((action) => ({ ...action, section: title }));
}

/** Where a divider (and, if the entry has a section, its heading) goes:
 * before the first entry of every group but the first. */
export function startsMenuGroup(
  actions: readonly ContextMenuAction[],
  index: number,
): boolean {
  const current = actions[index];
  if (!current) return false;
  if (index === 0) return Boolean(current.section);
  return (actions[index - 1].section ?? "") !== (current.section ?? "");
}
