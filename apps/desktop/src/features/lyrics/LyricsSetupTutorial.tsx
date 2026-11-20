import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsSoftware } from "@libretracks/shared/models";

/** How many steps each program's setup has (texts under
 * `lyrics.tutorial.<program>.step<N>`). */
export const TUTORIAL_STEPS: Record<Exclude<LyricsSoftware, "unknown">, number> = {
  proPresenter: 4,
  freeShow: 4,
  holyrics: 4,
};

type Props = {
  software: Exclude<LyricsSoftware, "unknown">;
  /** Finished or skipped: either way it is not shown again for this program. */
  onDone: () => void;
};

/**
 * Step-by-step setup of the lyrics program, shown the first time a program
 * is picked. Skippable for whoever already knows how; it can be reopened
 * from the tab.
 */
export function LyricsSetupTutorial({ software, onDone }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const total = TUTORIAL_STEPS[software] + 1;
  const last = step === total - 1;
  const program = t(`lyrics.programs.${software}`);
  const title = last
    ? t("lyrics.tutorial.finalTitle")
    : t(`lyrics.tutorial.${software}.step${step + 1}Title`);
  const body = last
    ? t("lyrics.tutorial.finalBody")
    : t(`lyrics.tutorial.${software}.step${step + 1}`);

  return (
    <section
      className="lt-lyrics-tutorial"
      role="region"
      aria-label={t("lyrics.tutorial.title", { program })}
    >
      <header className="lt-lyrics-tutorial-header">
        <strong>{t("lyrics.tutorial.title", { program })}</strong>
        <span className="lt-lyrics-tutorial-count">
          {t("lyrics.tutorial.stepCount", { step: step + 1, total })}
        </span>
      </header>
      <ol className="lt-lyrics-tutorial-dots" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <li key={index} className={index === step ? "is-current" : index < step ? "is-done" : ""} />
        ))}
      </ol>
      <h4 className="lt-lyrics-tutorial-title">{title}</h4>
      <p className="lt-lyrics-tutorial-body">{body}</p>
      {last ? <p className="lt-lyrics-tutorial-tip">{t("lyrics.tutorial.tip")}</p> : null}
      <footer className="lt-lyrics-tutorial-actions">
        {last ? null : (
          <button type="button" className="lt-lyrics-tutorial-skip" onClick={onDone}>
            {t("lyrics.tutorial.skip")}
          </button>
        )}
        <span className="lt-lyrics-tutorial-spacer" />
        {step > 0 ? (
          <button type="button" onClick={() => setStep(step - 1)}>
            {t("lyrics.tutorial.back")}
          </button>
        ) : null}
        <button
          type="button"
          className="is-primary"
          onClick={() => (last ? onDone() : setStep(step + 1))}
        >
          {last ? t("lyrics.tutorial.done") : t("lyrics.tutorial.next")}
        </button>
      </footer>
    </section>
  );
}
