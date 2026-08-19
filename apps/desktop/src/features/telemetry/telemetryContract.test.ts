import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PRODUCT_EVENT_NAMES } from "./telemetry";

describe("telemetry contract", () => {
  it("keeps every allowlisted product event aligned with the API and D1 schema", () => {
    const repository = resolve(process.cwd(), "../..");
    const api = readFileSync(
      resolve(repository, "apps/website/functions/api/telemetry/events.ts"),
      "utf8",
    );
    const migrations = [
      "0003_product_telemetry.sql",
      "0004_live_view_telemetry.sql",
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
});
