import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PRODUCT_EVENT_NAMES } from "./telemetry";

const repository = resolve(process.cwd(), "../..");

describe("telemetry contract", () => {
  it("keeps every allowlisted product event aligned with the API and D1 schema", () => {
    const api = readFileSync(
      resolve(repository, "apps/website/functions/api/telemetry/events.ts"),
      "utf8",
    );
    const migrations = [
      "0003_product_telemetry.sql",
      "0004_live_view_telemetry.sql",
      "0006_daw_view_telemetry.sql",
    ].map((file) =>
      readFileSync(resolve(repository, "apps/website/migrations", file), "utf8"),
    ).join("\n");

    for (const event of PRODUCT_EVENT_NAMES) {
      expect(api, `${event} missing from API allowlist`).toContain(`"${event}"`);
      expect(migrations, `${event} missing from D1 CHECK constraint`).toContain(
        `'${event}'`,
      );
    }
  });

  it("keeps the local weekday accepted by the API and stored by D1", () => {
    const api = readFileSync(
      resolve(repository, "apps/website/functions/api/telemetry/events.ts"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(repository, "apps/website/migrations/0005_local_weekday.sql"),
      "utf8",
    );

    expect(api).toContain("localWeekday");
    expect(api).toContain("local_weekday");
    for (const weekday of ["0", "1", "2", "3", "4", "5", "6"]) {
      expect(api, `weekday ${weekday} rejected by the API`).toContain(
        `"${weekday}"`,
      );
      expect(migration, `weekday ${weekday} missing from the CHECK`).toContain(
        `'${weekday}'`,
      );
    }
    // Older clients omit the field entirely and must keep being accepted.
    expect(migration).toContain("DEFAULT 'unknown'");
  });
});
