/**
 * Share-token manager for the private product dashboard.
 *
 * Only mounted when the dashboard was opened with the maintainer's
 * `ANALYTICS_ADMIN_TOKEN`; the endpoint behind it refuses every other
 * credential regardless, so this is presentation rather than enforcement.
 *
 * The plaintext token exists exactly once, in the response to the request that
 * created it. Nothing here writes it to storage, the URL or the DOM beyond the
 * one-time panel, because the server keeps only its SHA-256 and could not give
 * it back.
 */

import type { AnalyticsCopy } from "./copy";

type TokenRecord = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  expired: boolean;
};

type Options = {
  copy: AnalyticsCopy;
  locale: string;
  adminToken: () => string | null;
};

const HOURS = 1;
const DAY = 24 * HOURS;

const EXPIRY_CHOICES: Array<{ key: string; hours: number | null }> = [
  { key: "24h", hours: DAY },
  { key: "7d", hours: 7 * DAY },
  { key: "30d", hours: 30 * DAY },
  { key: "90d", hours: 90 * DAY },
  { key: "365d", hours: 365 * DAY },
  // The maintainer asked for standing access to be possible. It is still a
  // revocable credential, which is what actually bounds it.
  { key: "never", hours: null },
];

const DEFAULT_EXPIRY = "30d";

export type TokenPanel = {
  element: HTMLElement;
  toggle: () => void;
  close: () => void;
  isOpen: () => boolean;
};

export function createTokenPanel(options: Options): TokenPanel {
  const { copy, locale, adminToken } = options;
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const numbers = new Intl.NumberFormat(locale);

  const panel = document.createElement("section");
  panel.className = "analytics-tokens";
  panel.hidden = true;

  const title = document.createElement("h3");
  title.textContent = copy.tokensTitle;
  const intro = document.createElement("p");
  intro.className = "stats-muted";
  intro.textContent = copy.tokensIntro;

  const form = document.createElement("form");
  form.className = "analytics-token-form";

  const labelField = document.createElement("label");
  const labelText = document.createElement("span");
  labelText.textContent = copy.tokensLabel;
  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.required = true;
  labelInput.maxLength = 60;
  labelInput.placeholder = copy.tokensLabelPlaceholder;
  labelField.append(labelText, labelInput);

  const expiryField = document.createElement("label");
  const expiryText = document.createElement("span");
  expiryText.textContent = copy.tokensExpiry;
  const expirySelect = document.createElement("select");
  EXPIRY_CHOICES.forEach((choice) => {
    const option = document.createElement("option");
    option.value = choice.key;
    option.textContent = copy[`expiry_${choice.key}`] ?? choice.key;
    option.selected = choice.key === DEFAULT_EXPIRY;
    expirySelect.append(option);
  });
  expiryField.append(expiryText, expirySelect);

  const create = document.createElement("button");
  create.type = "submit";
  create.className = "button-link";
  create.textContent = copy.tokensCreate;

  form.append(labelField, expiryField, create);

  const feedback = document.createElement("p");
  feedback.className = "analytics-token-feedback";
  feedback.hidden = true;

  const reveal = document.createElement("div");
  reveal.className = "analytics-token-reveal";
  reveal.hidden = true;

  const list = document.createElement("div");
  list.className = "analytics-token-list";

  panel.append(title, intro, form, feedback, reveal, list);

  function fail(message: string): void {
    feedback.textContent = message;
    feedback.hidden = false;
  }

  function clearFeedback(): void {
    feedback.hidden = true;
    feedback.textContent = "";
  }

  async function call(method: string, path = "", body?: unknown): Promise<Response> {
    const token = adminToken();
    return fetch(`/api/telemetry/access-tokens${path}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token ?? ""}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function messageFor(payload: { error?: string }): string {
    switch (payload.error) {
      case "migration_required":
        return copy.migrationRequired;
      case "too_many_tokens":
        return copy.tokensTooMany;
      case "invalid_label":
        return copy.tokensInvalidLabel;
      case "unauthorized":
        return copy.unauthorized;
      case "admin_token_not_configured":
        return copy.notConfigured;
      default:
        return copy.tokensFailed;
    }
  }

  function describe(record: TokenRecord): string {
    const created = `${copy.tokensCreated}: ${dates.format(Date.parse(record.createdAt))}`;
    const expiry =
      record.expiresAt === null
        ? copy.tokensNever
        : `${record.expired ? copy.tokensExpired : copy.tokensExpires}: ${dates.format(Date.parse(record.expiresAt))}`;
    const used =
      record.lastUsedAt === null
        ? copy.tokensNeverUsed
        : `${copy.tokensLastUsed}: ${dates.format(Date.parse(record.lastUsedAt))} · ${numbers.format(record.useCount)} ${copy.tokensUses}`;
    return `${created} · ${expiry} · ${used}`;
  }

  function renderList(records: TokenRecord[]): void {
    list.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement("p");
      empty.className = "stats-muted";
      empty.textContent = copy.tokensEmpty;
      list.append(empty);
      return;
    }
    records.forEach((record) => {
      const row = document.createElement("article");
      row.className = `analytics-token-row${record.expired ? " is-expired" : ""}`;
      const name = document.createElement("strong");
      name.textContent = record.label;
      const detail = document.createElement("small");
      detail.textContent = describe(record);
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "analytics-token-revoke";
      revoke.textContent = copy.tokensRevoke;
      revoke.addEventListener("click", () => {
        if (!window.confirm(copy.tokensRevokeConfirm.replace("{label}", record.label))) return;
        void remove(record.id);
      });
      row.append(name, detail, revoke);
      list.append(row);
    });
  }

  async function refresh(): Promise<void> {
    try {
      const response = await call("GET");
      const payload = (await response.json()) as { tokens?: TokenRecord[]; error?: string };
      if (!response.ok) {
        fail(messageFor(payload));
        list.replaceChildren();
        return;
      }
      clearFeedback();
      renderList(payload.tokens ?? []);
    } catch {
      fail(copy.tokensFailed);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      const response = await call("DELETE", `?id=${encodeURIComponent(id)}`);
      if (!response.ok) {
        fail(messageFor((await response.json()) as { error?: string }));
        return;
      }
      await refresh();
    } catch {
      fail(copy.tokensFailed);
    }
  }

  function showToken(plaintext: string): void {
    reveal.replaceChildren();
    reveal.hidden = false;
    const heading = document.createElement("strong");
    heading.textContent = copy.tokensGeneratedTitle;
    const value = document.createElement("code");
    value.textContent = plaintext;
    // Selecting the whole token in one gesture is the fallback when the
    // clipboard API is unavailable, which it is on an insecure origin.
    value.tabIndex = 0;
    value.addEventListener("focus", () => {
      const selection = window.getSelection();
      const rangeSelection = document.createRange();
      rangeSelection.selectNodeContents(value);
      selection?.removeAllRanges();
      selection?.addRange(rangeSelection);
    });
    const note = document.createElement("p");
    note.className = "stats-muted";
    note.textContent = copy.tokensGeneratedNote;

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "button-link";
    copyButton.textContent = copy.tokensCopy;
    copyButton.addEventListener("click", () => {
      void navigator.clipboard
        ?.writeText(plaintext)
        .then(() => {
          copyButton.textContent = copy.tokensCopied;
        })
        .catch(() => {
          copyButton.textContent = copy.tokensCopyFailed;
        });
    });

    const done = document.createElement("button");
    done.type = "button";
    done.className = "analytics-token-dismiss";
    done.textContent = copy.tokensDone;
    done.addEventListener("click", () => {
      reveal.hidden = true;
      reveal.replaceChildren();
    });

    const actions = document.createElement("div");
    actions.className = "analytics-token-actions";
    actions.append(copyButton, done);
    reveal.append(heading, value, note, actions);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const label = labelInput.value.trim();
    if (!label) {
      fail(copy.tokensInvalidLabel);
      return;
    }
    const choice = EXPIRY_CHOICES.find((item) => item.key === expirySelect.value);
    create.disabled = true;
    create.textContent = copy.tokensGenerating;
    void (async () => {
      try {
        const response = await call("POST", "", {
          label,
          expiresInHours: choice?.hours ?? null,
        });
        const payload = (await response.json()) as { token?: string; error?: string };
        if (!response.ok || !payload.token) {
          fail(messageFor(payload));
          return;
        }
        clearFeedback();
        labelInput.value = "";
        showToken(payload.token);
        await refresh();
      } catch {
        fail(copy.tokensFailed);
      } finally {
        create.disabled = false;
        create.textContent = copy.tokensCreate;
      }
    })();
  });

  return {
    element: panel,
    isOpen: () => !panel.hidden,
    close: () => {
      panel.hidden = true;
    },
    toggle: () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) void refresh();
    },
  };
}
