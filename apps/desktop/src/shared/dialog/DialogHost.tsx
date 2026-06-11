import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type DialogRequest, registerDialogHost } from "./dialogService";

// Renders the active prompt/confirm dialog requested via dialogService. Mount it
// once near the app root.
export function DialogHost() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return registerDialogHost((next) => {
      // If a request is already open, cancel it before showing the new one.
      setRequest((current) => {
        if (current) {
          if (current.type === "prompt") current.resolve(null);
          else current.resolve(false);
        }
        return next;
      });
      setValue(next.type === "prompt" ? next.defaultValue : "");
    });
  }, []);

  useEffect(() => {
    if (!request) return;

    const id = window.requestAnimationFrame(() => {
      if (request.type === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        primaryButtonRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [request]);

  if (!request) {
    return null;
  }

  const close = (result: string | null | boolean) => {
    const active = request;
    setRequest(null);
    if (active.type === "prompt") {
      active.resolve(result as string | null);
    } else {
      active.resolve(result as boolean);
    }
  };

  const onSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    close(request.type === "prompt" ? value : true);
  };

  const cancel = () => close(request.type === "prompt" ? null : false);

  const okLabel = t("common.ok", { defaultValue: "OK" });
  const cancelLabel = t("common.cancel", { defaultValue: "Cancel" });

  return (
    <div
      role="presentation"
      className="lt-dialog-layer"
    >
      <form
        role="dialog"
        aria-modal="false"
        aria-labelledby="lt-dialog-title"
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          }
        }}
        className="lt-dialog-card"
      >
        <div className="lt-dialog-accent" aria-hidden="true" />
        <p className="lt-dialog-eyebrow">LibreTracks</p>
        {request.type === "prompt" ? (
          <>
            <label
              id="lt-dialog-title"
              className="lt-dialog-message"
              htmlFor="lt-dialog-input"
            >
              {request.message}
            </label>
            <input
              id="lt-dialog-input"
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="lt-dialog-input"
            />
          </>
        ) : (
          <p id="lt-dialog-title" className="lt-dialog-message">
            {request.message}
          </p>
        )}
        <div className="lt-dialog-actions">
          <button
            type="button"
            onClick={cancel}
            className="lt-dialog-button"
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            ref={primaryButtonRef}
            className="lt-dialog-button lt-dialog-button--primary"
          >
            {okLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
