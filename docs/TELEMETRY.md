# LibreTracks privacy-preserving usage statistics

The client, Cloudflare Pages Functions and dashboards are implemented in:

- `apps/desktop/src/features/telemetry/`
- `apps/website/functions/api/telemetry/`
- `apps/website/src/pages/usage.astro` and `apps/website/src/pages/es/usage.astro`
- `apps/website/src/pages/admin/analytics.astro` and its Spanish equivalent
- `apps/website/src/components/analytics/` (dashboard client, split by concern:
  `dashboard.ts`, `filters.ts`, `tokens.ts`, `copy.ts`)

No event is sent until the user explicitly opts in. The installation secret remains in local storage;
the server receives a SHA-256 derivative that rotates each UTC day. Cloudflare
derives a two-letter country code from the network request at the edge; neither
the IP address nor a more precise location is written to the telemetry database.
Country is stored only when the event includes consent version 2 or later. Older clients
remain compatible but are recorded with country `XX`, because their original
consent disclosure did not include country-level analytics.

The public dashboard provides rolling 24-hour, 7-day and 30-day totals, hourly
and daily UTC trends, and 30-day country/version/platform breakdowns. Timeline
buckets and breakdowns with fewer than five devices are suppressed.

`app_started` also carries the weekday the start happened on according to the
device's own calendar, as a single digit from `0` (Sunday) to `6` (Saturday).
It cannot be derived from `utc_day`: a Sunday evening service anywhere in the
Americas is already Monday in UTC, so a server-side weekday would move exactly
the worship services this metric exists to count into Monday. The field carries
three bits and no calendar date, is optional, and clients that predate it are
stored as `unknown`. It answers whether LibreTracks runs at services or at
weekday rehearsals; the private dashboard charts it and reports the Sunday
share of reporting device-days.

Consent version 3 enables the closed product-event taxonomy defined by
`PRODUCT_EVENT_NAMES`. It covers activation, feature adoption, selected action
outcomes and 5/15/30/60-minute active-session milestones. Every product event
is emitted at most once per app process. No event accepts names, paths, error
messages or arbitrary properties. Installation age and cumulative active days
are computed locally and sent only as broad buckets.

The private product dashboard uses Apache ECharts with SVG rendering for
interactive daily trends, UTC hourly activity, activation funnel and feature
adoption. It also shows comparisons with the preceding period, versions,
operating systems, device classes and a country-level choropleth map. Geography is
always aggregated from the existing two-letter edge country code; the dashboard
does not collect or expose cities, coordinates or IP addresses.

## Cross-filtering

Every ranking and chart on the private dashboard is also a control. Clicking a
country, a UTC hour, a weekday, a version, an operating system, a device class,
a maturity bucket, a feature bar or a session-depth row narrows every other
panel to that slice, and the selections stack: values inside one dimension are
an OR, dimensions are an AND. Active selections appear as removable chips above
the grid.

Three details are worth knowing before changing this code, all of them in
`functions/api/telemetry/_filters.ts`:

- A ranking is never filtered by its own dimension. Picking Spain has to leave
  every country on screen, marked, or the only way to look at the next country
  would be to clear the filter first. Each ranking query therefore runs with its
  own dimension excluded, while the summary cards, the daily trend, the funnel
  and the reliability rows use the full selection.
- The two tables do not carry the same columns. Weekday, installation age and
  cumulative active days exist only on `telemetry_events`; event names exist
  only on `telemetry_product_events`. Filtering the other table is done by
  selecting the matching device-days via `(utc_day, daily_device_token)`, which
  is the grain every metric on the dashboard already counts by.
- An event selection is never applied as `event_name IN (...)` on the product
  table. The question being asked is what those device-days did in total, not
  how many times they triggered the event that selected them, so it is always a
  cohort.

Filtering adds no new data: every dimension was already stored and already
visible as a breakdown. It changes how the existing aggregates are sliced, not
what is collected.

## Share tokens

`ANALYTICS_ADMIN_TOKEN` is the maintainer's credential and stays that way.
Anyone else who needs to read the numbers gets a row in
`analytics_access_tokens` instead (migration 0007), created from the token panel
in the dashboard itself.

- The token is generated on the edge from `crypto.getRandomValues`, 24 random
  bytes rendered as base64url behind an `ltm_` prefix. Only its SHA-256 is
  stored, so the plaintext exists exactly once, in the response to the request
  that created it, and a copy of the table is not a set of working passwords.
- A token carries an optional expiry. "Never expires" is deliberately offered:
  some people need standing access, and a date far enough out to fake it is a
  lie. What actually bounds the risk is that every token is revocable on its
  own, which the shared admin secret never was.
- A share token reaches `product-stats` and nothing else. Presenting one to
  `access-tokens` is answered with the same 401 as a wrong token, so its holder
  cannot mint more tokens or revoke the maintainer's, and cannot learn that the
  token is genuine but insufficient.
- Revocation is a hard delete. A disabled row that still matches a hash is one
  bug away from letting the token back in.
- Use is recorded (last seen, count) outside the response path via
  `waitUntil`, and tokens that expired more than 30 days ago are pruned
  opportunistically on the same pass.

A share token grants exactly what the dashboard shows: aggregate counts over
opted-in installs. It reaches no raw rows, no device tokens and nothing outside
this page.

## Cloudflare setup

1. Create a D1 database named `libretracks-telemetry`.
2. Apply the SQL files in `apps/website/migrations` in numeric order in the D1
   SQL console (or with Wrangler's `d1 execute --remote --file` command). An
   existing installation must run only the numbered files it has not yet
   applied. Product metrics require `0003_product_telemetry.sql`, the weekday
   chart requires `0005_local_weekday.sql`, DAW view adoption requires
   `0006_daw_view_telemetry.sql`, and share tokens require
   `0007_analytics_access_tokens.sql`. Until that last one is applied the
   dashboard still works for the maintainer and says which migration is
   missing when the token panel is opened.
3. In the LibreTracks Pages project, add a D1 binding named exactly
   `TELEMETRY_DB` and select that database for both production and preview.
4. Confirm the Pages project root is `apps/website`. Pages Functions must live
   in the configured project root; if Cloudflare is instead configured with the
   repository root, move/copy `apps/website/functions` to root `functions` or
   change the Pages root before deploying.
5. Redeploy the website, then verify `GET /api/telemetry/stats` returns JSON.
6. Add a production Pages secret named `ANALYTICS_ADMIN_TOKEN` containing at
   least 15 random characters. Open `/es/admin/analytics/`, enter that token,
   and verify the 7/30/90-day views. The token stays in browser session storage
   and is sent only in the HTTPS `Authorization` header, never in the URL.
7. To give someone read-only access, open the dashboard with the admin token,
   press **Tokens**, name the token after whoever it is for, pick an expiry (or
   "never expires") and copy the generated string. It is shown once. Send it
   over a private channel and have them paste it into the same access form; the
   token is never put in a URL, so there is no link to share. Revoke it from
   the same panel when it is no longer needed.
8. As defence in depth, protect `/admin/*`, `/es/admin/*` and
   `/api/telemetry/product-stats*` with a Cloudflare Access self-hosted
   application restricted to the maintainer identity. Note that this also gates
   share tokens: anyone given one has to be able to reach the page, so either
   add them to the Access policy or keep Access limited to `/admin/*` and leave
   `/api/telemetry/product-stats*` to the token check.

The endpoint enforces a 90-day event retention window opportunistically on
writes. For guaranteed deletion even during a 90-day period with no traffic,
add a monthly scheduled Worker that runs the same deletion query.

## Release/privacy checklist

- Keep `libretracks.app@gmail.com` monitored as the private contact address for
  privacy questions and data-protection requests.
- Keep Cloudflare's data-processing terms and transfer settings documented.
- Keep country inference limited to Cloudflare's two-letter edge country code;
  do not add regions, cities or coordinates.
- Keep the local calendar signal limited to the weekday; a local date, clock
  time or UTC offset would narrow a device far more than a weekday does.
- Do not add project names, paths, audio/MIDI device names, precise OS versions,
  IP addresses, full User-Agent strings or persistent identifiers.
- If a new event or field is added, update both privacy pages and request fresh
  consent when the purpose materially changes.
- Keep public cohort suppression at five devices or higher.
- Keep share tokens hash-only in the database, read-only in scope, and out of
  URLs. Review the token list periodically and revoke what is no longer in use.
- Keep cross-filtering limited to dimensions already collected. A filter that
  needed a new column would be a new field, and the rules above apply to it.

This design is deliberately conservative, but the project maintainer remains
responsible for obtaining jurisdiction-specific legal advice where required.
