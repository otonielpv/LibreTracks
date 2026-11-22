import { isMobileApp } from "../desktopApi";

/** The phone screens the Live view already lays out for (LivePerformanceView.css). */
export const PHONE_QUERY = "(max-width: 820px), (max-height: 500px)";

/** Whether this is the mobile app on a phone right now (tablets and desktop: no). */
export function isPhoneScreenNow(): boolean {
  return isMobileApp && typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true;
}
