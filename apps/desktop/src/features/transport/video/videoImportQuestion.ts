import type { VideoImportQuestion } from "../desktopApi";
import { formatBytes } from "./VideoExportOption";

/**
 * What the "bring the videos too?" question shows (plan video-mobile, paso
 * 08 §1). Pure, so the three cases that matter — fits with a margin, does
 * not fit, no videos — and their texts are tested without rendering.
 *
 * The backend decided `fits` (free ≥ size + 1 GB) and the default; this only
 * turns it into words. A question with no videos is no question: `null`.
 */
export type VideoImportQuestionView = {
  summary: string;
  free: string | null;
  checkboxLabel: string;
  hint: string;
  enabled: boolean;
  defaultChecked: boolean;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function describeVideoImportQuestion(
  question: VideoImportQuestion,
  t: Translate,
  locale?: string,
): VideoImportQuestionView | null {
  if (question.count <= 0) return null;
  const device = question.source === "device";
  const size = formatBytes(question.bytes, locale);
  return {
    summary: t(device ? "transport.video.importQuestion.device" : "transport.video.importQuestion.package", {
      count: question.count,
      size,
    }),
    free:
      question.freeBytes === null
        ? null
        : t("transport.video.importQuestion.free", { size: formatBytes(question.freeBytes, locale) }),
    checkboxLabel: t(
      device ? "transport.video.importQuestion.includeDevice" : "transport.video.importQuestion.includePackage",
    ),
    hint: question.fits
      ? t(device ? "transport.video.importQuestion.hintDevice" : "transport.video.importQuestion.hintPackage")
      : t("transport.video.importQuestion.noRoom"),
    enabled: question.fits,
    defaultChecked: question.fits && question.defaultInclude,
  };
}

/** Above this, a Drive download on mobile data asks first (paso 08 §4). */
export const CLOUD_CELLULAR_CONFIRM_BYTES = 200 * 1024 * 1024;

/** What the browser says about the connection: Android's WebView reports
 * `navigator.connection.type`; iOS's does not (then nothing is asked). */
export function connectionType(): string | null {
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  return connection?.type ?? null;
}

/** Whether to ask before downloading `bytes` from Drive. */
export function shouldConfirmCloudDownload(bytes: number, connection: string | null): boolean {
  return connection === "cellular" && bytes > CLOUD_CELLULAR_CONFIRM_BYTES;
}
