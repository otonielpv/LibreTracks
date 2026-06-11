import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type DialogRequest, registerDialogHost } from "./dialogService";

// Renders the active prompt/confirm dialog requested via dialogService. Mount it
// once near the app root. Self-contained inline styles so it renders regardless
// of app CSS state, and on top of everything.
export function DialogHost() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

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
    if (request?.type === "prompt") {
      // Focus + select after the dialog paints.
      const id = window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => window.cancelAnimationFrame(id);
    }
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
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.5)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: "min(420px, calc(100vw - 48px))",
          background: "#1f2430",
          color: "#e5e7eb",
          border: "1px solid #374151",
          borderRadius: "10px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
          padding: "20px",
          boxSizing: "border-box",
        }}
      >
        <p
          style={{
            margin: 0,
            marginBottom: "14px",
            fontSize: "14px",
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
          }}
        >
          {request.message}
        </p>
        {request.type === "prompt" ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              fontSize: "14px",
              color: "#f9fafb",
              background: "#111827",
              border: "1px solid #4b5563",
              borderRadius: "6px",
              marginBottom: "18px",
              outline: "none",
            }}
          />
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
          }}
        >
          <button
            type="button"
            onClick={cancel}
            style={{
              padding: "8px 14px",
              fontSize: "13px",
              color: "#e5e7eb",
              background: "transparent",
              border: "1px solid #4b5563",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            style={{
              padding: "8px 14px",
              fontSize: "13px",
              color: "#0b1220",
              background: "#34d399",
              border: "1px solid #34d399",
              borderRadius: "6px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {okLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
