# LibreTracks privacy-preserving usage statistics

The client, Cloudflare Pages Functions and dashboards are implemented in:

- `apps/desktop/src/features/telemetry/`
- `apps/website/functions/api/telemetry/`
- `apps/website/src/pages/usage.astro` and `apps/website/src/pages/es/usage.astro`
- `apps/website/src/pages/admin/analytics.astro` and its Spanish equivalent

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

Consent version 3 enables the closed product-event taxonomy defined by
`PRODUCT_EVENT_NAMES`. It covers activation, feature adoption, selected action
outcomes and 5/15/30/60-minute active-session milestones. Every product event
is emitted at most once per app process. No event accepts names, paths, error
messages or arbitrary properties. Installation age and cumulative active days
are computed locally and sent only as broad buckets.

The private product dashboard uses Apache ECharts with SVG rendering for
interactive daily trends, UTC hourly activity, activation funnel and feature
adoption. It also shows comparisons with the preceding period, versions,
operating systems, device classes and a country-level bubble map. Geography is
always aggregated from the existing two-letter edge country code; the dashboard
does not collect or expose cities, coordinates or IP addresses.

## Cloudflare setup

1. Create a D1 database named `libretracks-telemetry`.
2. Apply the SQL files in `apps/website/migrations` in numeric order in the D1
   SQL console (or with Wrangler's `d1 execute --remote --file` command). An
   existing installation must run only the numbered files it has not yet
   applied. Product metrics require `0003_product_telemetry.sql`.
3. In the LibreTracks Pages project, add a D1 binding named exactly
   `TELEMETRY_DB` and select that database for both production and preview.
4. Confirm the Pages project root is `apps/website`. Pages Functions must live
   in the configured project root; if Cloudflare is instead configured with the
   repository root, move/copy `apps/website/functions` to root `functions` or
   change the Pages root before deploying.
5. Redeploy the website, then verify `GET /api/telemetry/stats` returns JSON.
6. Add a production Pages secret named `ANALYTICS_ADMIN_TOKEN` containing at
   least 15 random characters. Open `/es/admin/analytics/`, enter that token,
   and verify the 7/30/90-day views. The token stays in browser session storage.
7. As defence in depth, protect `/admin/*`, `/es/admin/*` and
   `/api/telemetry/product-stats*` with a Cloudflare Access self-hosted
   application restricted to the maintainer identity.

The endpoint enforces a 90-day event retention window opportunistically on
writes. For guaranteed deletion even during a 90-day period with no traffic,
add a monthly scheduled Worker that runs the same deletion query.

## Release/privacy checklist

- Keep `libretracks.app@gmail.com` monitored as the private contact address for
  privacy questions and data-protection requests.
- Keep Cloudflare's data-processing terms and transfer settings documented.
- Keep country inference limited to Cloudflare's two-letter edge country code;
  do not add regions, cities or coordinates.
- Do not add project names, paths, audio/MIDI device names, precise OS versions,
  IP addresses, full User-Agent strings or persistent identifiers.
- If a new event or field is added, update both privacy pages and request fresh
  consent when the purpose materially changes.
- Keep public cohort suppression at five devices or higher.

This design is deliberately conservative, but the project maintainer remains
responsible for obtaining jurisdiction-specific legal advice where required.
