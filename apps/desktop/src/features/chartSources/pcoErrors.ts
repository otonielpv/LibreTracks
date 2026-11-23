import type { TFunction } from "i18next";

import type { PcoErrorInfo } from "../transport/desktopApi";

/** A rejected `pco_*` command: Tauri hands over the serialized `PcoError`. */
export function toPcoError(cause: unknown): PcoErrorInfo | string {
  if (cause && typeof cause === "object" && "code" in cause && typeof (cause as { code: unknown }).code === "string") {
    return cause as PcoErrorInfo;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** The user-facing sentence of a Planning Center failure. */
export function pcoErrorMessage(t: TFunction, error: PcoErrorInfo | string | null): string | null {
  if (error === null) return null;
  if (typeof error === "string") return t("chartSources.errors.unexpected", { message: error });
  switch (error.code) {
    case "rateLimited":
      return t("chartSources.errors.rateLimited", { seconds: error.retryAfterSecs });
    case "network":
    case "unexpected":
      return t(`chartSources.errors.${error.code}`, { message: error.message });
    case "provider":
      return t("chartSources.errors.provider", { status: error.status, detail: error.detail });
    default:
      return t(`chartSources.errors.${error.code}`);
  }
}
