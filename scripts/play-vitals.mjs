// Reads Android vitals from the Google Play Developer Reporting API, so crash
// and ANR data can be inspected without opening Play Console.
//
//   node scripts/play-vitals.mjs rates
//     Crash and ANR rate per versionCode over the last 28 days (user-perceived
//     rates are the ones Play compares with the bad-behaviour thresholds).
//
//   node scripts/play-vitals.mjs issues [CRASH|ANR]
//     Error clusters (newest data Play has), most reports first.
//
//   node scripts/play-vitals.mjs reports <issueId> [count]
//     Full stack traces of the latest reports in one cluster.
//
// Credentials: PLAY_SERVICE_ACCOUNT_JSON (the key file's contents) or
// PLAY_SERVICE_ACCOUNT_FILE (a path to it). The service account needs the
// "View app information" permission in Play Console, and the Google Play
// Developer Reporting API must be enabled in its Cloud project.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const PACKAGE_NAME = "com.libretracks.app";
const API = `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${PACKAGE_NAME}`;
const SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const readServiceAccount = () => {
  let raw = process.env.PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw && process.env.PLAY_SERVICE_ACCOUNT_FILE) {
    raw = readFileSync(process.env.PLAY_SERVICE_ACCOUNT_FILE, "utf8");
  }
  if (!raw) fail("set PLAY_SERVICE_ACCOUNT_JSON or PLAY_SERVICE_ACCOUNT_FILE.");
  try {
    return JSON.parse(raw);
  } catch {
    fail("the service account key is not valid JSON.");
  }
};

const accessToken = async ({ client_email, private_key, token_uri }) => {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: client_email,
    scope: SCOPE,
    aud: token_uri,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64url");
  const response = await fetch(token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(body)}`);
  return body.access_token;
};

const client = (token) => async (method, url, json) => {
  const headers = { Authorization: `Bearer ${token}` };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await response.text();
  if (!response.ok) {
    // 403 PERMISSION_DENIED: API not enabled in the Cloud project, or the
    // "View app information" permission is missing / still propagating.
    throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
};

const pct = (value) => (value == null ? "   -   " : `${(Number(value) * 100).toFixed(2)} %`.padStart(7));

// Daily metric sets are reported in America/Los_Angeles; the query must end at
// or before the freshness the set advertises.
const dailyWindow = async (call, metricSet, days) => {
  const meta = await call("GET", `${API}/${metricSet}`);
  const daily = meta.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === "DAILY");
  if (!daily) fail(`${metricSet} has no DAILY freshness.`);
  const end = daily.latestEndTime;
  const endDate = new Date(Date.UTC(end.year, end.month - 1, end.day));
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const toSpec = (d) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    timeZone: end.timeZone,
  });
  return { aggregationPeriod: "DAILY", startTime: toSpec(startDate), endTime: toSpec(endDate) };
};

// Collapses daily rows into one rate per versionCode, weighting each day by
// its distinct users (the same way Play aggregates the 28-day figure).
const ratesByVersion = async (call, metricSet, metrics) => {
  const timelineSpec = await dailyWindow(call, metricSet, 28);
  const rows = [];
  let pageToken;
  do {
    const page = await call("POST", `${API}/${metricSet}:query`, {
      timelineSpec,
      dimensions: ["versionCode"],
      metrics: [...metrics, "distinctUsers"],
      pageSize: 1000,
      pageToken,
    });
    rows.push(...(page.rows ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  const byVersion = new Map();
  for (const row of rows) {
    const version = row.dimensions?.find((d) => d.dimension === "versionCode")?.stringValue ?? "?";
    const value = (name) => Number(row.metrics?.find((m) => m.metric === name)?.decimalValue?.value ?? NaN);
    const users = value("distinctUsers") || 0;
    const acc = byVersion.get(version) ?? { users: 0, sums: Object.fromEntries(metrics.map((m) => [m, 0])) };
    acc.users += users;
    for (const m of metrics) {
      const v = value(m);
      if (!Number.isNaN(v)) acc.sums[m] += v * users;
    }
    byVersion.set(version, acc);
  }
  return new Map(
    [...byVersion].map(([version, { users, sums }]) => [
      version,
      { users, ...Object.fromEntries(metrics.map((m) => [m, users ? sums[m] / users : null])) },
    ]),
  );
};

const rates = async (call) => {
  const crash = await ratesByVersion(call, "crashRateMetricSet", ["crashRate", "userPerceivedCrashRate"]);
  const anr = await ratesByVersion(call, "anrRateMetricSet", ["anrRate", "userPerceivedAnrRate"]);
  const versions = [...new Set([...crash.keys(), ...anr.keys()])].sort((a, b) => Number(b) - Number(a));
  console.log("Last 28 days, per versionCode (user-days = sum of daily distinct users)");
  console.log("versionCode  user-days   crash   perc.crash    anr    perc.anr");
  for (const v of versions) {
    const c = crash.get(v) ?? {};
    const a = anr.get(v) ?? {};
    console.log(
      `${v.padEnd(11)} ${String(Math.round(c.users ?? a.users ?? 0)).padStart(10)}  ${pct(c.crashRate)}  ${pct(
        c.userPerceivedCrashRate,
      )}    ${pct(a.anrRate)}  ${pct(a.userPerceivedAnrRate)}`,
    );
  }
  console.log("\nThresholds (user-perceived): crash 1.09 %, ANR 0.47 %.");
};

const issues = async (call, type) => {
  const all = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (type) params.set("filter", `errorIssueType = ${type}`);
    if (pageToken) params.set("pageToken", pageToken);
    const page = await call("GET", `${API}/errorIssues:search?${params}`);
    all.push(...(page.errorIssues ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  all.sort((a, b) => Number(b.errorReportCount ?? 0) - Number(a.errorReportCount ?? 0));
  for (const issue of all) {
    const id = issue.name.split("/").pop();
    console.log(
      `[${issue.type}] ${id}  reports=${issue.errorReportCount ?? "?"} users=${issue.distinctUsers ?? "?"}  ` +
        `versions ${issue.firstAppVersion?.versionCode ?? "?"}..${issue.lastAppVersion?.versionCode ?? "?"}`,
    );
    console.log(`    ${issue.cause ?? ""}`);
    console.log(`    at ${issue.location ?? "?"}`);
  }
  if (!all.length) console.log("No error issues returned.");
};

const reports = async (call, issueId, count) => {
  if (!issueId) fail("usage: reports <issueId> [count]");
  const params = new URLSearchParams({ pageSize: String(count), filter: `errorIssueId = ${issueId}` });
  const page = await call("GET", `${API}/errorReports:search?${params}`);
  for (const report of page.errorReports ?? []) {
    console.log("=".repeat(80));
    console.log(
      `${report.eventTime ?? ""}  versionCode=${report.appVersion?.versionCode ?? "?"}  ` +
        `device=${report.deviceModel?.marketingName ?? report.deviceModel?.deviceId?.buildDevice ?? "?"}  ` +
        `android=${report.osVersion?.apiLevel ?? "?"}`,
    );
    console.log(report.reportText ?? "(no text)");
  }
  if (!page.errorReports?.length) console.log("No reports returned.");
};

const [command, arg1, arg2] = process.argv.slice(2);
const call = client(await accessToken(readServiceAccount()));
if (command === "rates") await rates(call);
else if (command === "issues") await issues(call, arg1?.toUpperCase());
else if (command === "reports") await reports(call, arg1, Number(arg2) || 3);
else fail("usage: play-vitals.mjs rates | issues [CRASH|ANR] | reports <issueId> [count]");
