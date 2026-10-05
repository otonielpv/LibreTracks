import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  answerVideoImportQuestion,
  isTauriApp,
  listenToVideoImportQuestion,
  type VideoImportQuestion,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { describeVideoImportQuestion } from "./videoImportQuestion";

/**
 * "This package carries 3 videos (2.4 GB). Free space: 11.2 GB. [✓] Import
 * the videos too" (plan video-mobile, paso 08). The backend's import waits
 * on its worker thread for the answer; closing with Back sends the default.
 * Only phones ask; mounted everywhere, it stays empty on the desktop.
 */
export function VideoImportQuestionModal() {
  const { t, i18n } = useTranslation();
  const [question, setQuestion] = useState<VideoImportQuestion | null>(null);
  const [include, setInclude] = useState(false);

  useEffect(() => {
    if (!isTauriApp) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenToVideoImportQuestion((next) => {
      setQuestion(next);
      setInclude(next.fits && next.defaultInclude);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const answer = useCallback(
    (value: boolean) => {
      if (!question) return;
      void answerVideoImportQuestion(question.requestId, value).catch(() => undefined);
      setQuestion(null);
    },
    [question],
  );
  const view = question ? describeVideoImportQuestion(question, t, i18n.language) : null;
  const dismiss = useCallback(() => answer(view?.defaultChecked ?? false), [answer, view?.defaultChecked]);
  useDismissOnBack(dismiss, view !== null);
  if (!question || !view) return null;

  return (
    <div className="lt-modal-backdrop">
      <section
        className="lt-settings-modal lt-video-import-question"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-video-import-question-title"
      >
        <header className="lt-settings-modal-header">
          <h2 id="lt-video-import-question-title">{t("transport.video.importQuestion.title")}</h2>
        </header>
        <div className="lt-video-wizard-body">
          <p>{view.summary}</p>
          {view.free ? <p>{view.free}</p> : null}
          <label className="lt-video-settings-row">
            <input
              type="checkbox"
              checked={include}
              disabled={!view.enabled}
              onChange={(event) => setInclude(event.target.checked)}
            />
            <span>{view.checkboxLabel}</span>
          </label>
          <small>{view.hint}</small>
        </div>
        <footer className="lt-video-wizard-footer">
          <span className="lt-video-wizard-spacer" />
          <button type="button" className="is-primary" onClick={() => answer(include && view.enabled)}>
            {t("transport.video.importQuestion.continue")}
          </button>
        </footer>
      </section>
    </div>
  );
}
