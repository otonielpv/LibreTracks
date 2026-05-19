import { recordRender } from "./perfMetrics";

/**
 * Bump the perf-HUD render counter for `componentName` every time the
 * caller renders. Cheap no-op when the HUD is off (recordRender early-
 * returns based on the `started` flag in perfMetrics).
 *
 * Intentionally not a hook with state — calling recordRender inline
 * during render is fine because the metrics module is a plain singleton
 * and the function does nothing during the same-render cycle.
 */
export function useRenderCounter(componentName: string) {
  recordRender(componentName);
}
