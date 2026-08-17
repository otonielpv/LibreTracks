# LibreTracks anonymous usage statistics

The client, Cloudflare Pages Functions and public dashboard are implemented in:

- `apps/desktop/src/features/telemetry/`
- `apps/website/functions/api/telemetry/`
- `apps/website/src/pages/usage.astro` and `apps/website/src/pages/es/usage.astro`

No event is sent until the user explicitly opts in. The only event currently
implemented is `app_started`. The installation secret remains in local storage;
the server receives a SHA-256 derivative that rotates each UTC day.

## Cloudflare setup

1. Create a D1 database named `libretracks-telemetry`.
2. Apply `apps/website/migrations/0001_telemetry.sql` in the D1 SQL console (or
   with Wrangler's `d1 execute --remote --file` command).
3. In the LibreTracks Pages project, add a D1 binding named exactly
   `TELEMETRY_DB` and select that database for both production and preview.
4. Confirm the Pages project root is `apps/website`. Pages Functions must live
   in the configured project root; if Cloudflare is instead configured with the
   repository root, move/copy `apps/website/functions` to root `functions` or
   change the Pages root before deploying.
5. Redeploy the website, then verify `GET /api/telemetry/stats` returns JSON.

The endpoint enforces a 90-day event retention window opportunistically on
writes. For guaranteed deletion even during a 90-day period with no traffic,
add a monthly scheduled Worker that runs the same deletion query.

## Release/privacy checklist

- Keep `libretracks.app@gmail.com` monitored as the private contact address for
  privacy questions and data-protection requests.
- Keep Cloudflare's data-processing terms and transfer settings documented.
- Do not add project names, paths, audio/MIDI device names, precise OS versions,
  IP addresses, full User-Agent strings or persistent identifiers.
- If a new event or field is added, update both privacy pages and request fresh
  consent when the purpose materially changes.
- Keep public cohort suppression at five devices or higher.

This design is deliberately conservative, but the project maintainer remains
responsible for obtaining jurisdiction-specific legal advice where required.
