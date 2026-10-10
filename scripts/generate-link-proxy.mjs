#!/usr/bin/env node
// Generates the two halves of the network-session guest mirror from
// scripts/link-commands.json (docs/plans/network-sessions):
//
// - packages/shared/src/guestCommandTable.ts: which commands the guest UI
//   keeps on its own device, sends to the host, or refuses.
// - apps/desktop/src-tauri/src/link/proxy_dispatch.rs: on the host, the role
//   each proxied command needs and a `dispatch` that calls the real Tauri
//   command function with the arguments the guest sent.
//
// The dispatcher never names an argument type: each argument is
// deserialized with `proxy::arg`, and Rust infers the type from the
// command's own parameter. `State<..>` parameters become `app.state()` and
// `AppHandle` becomes the host's handle. Sync commands run on a blocking
// thread, as Tauri itself runs them off the async runtime.
//
// Run: `npm run gen:link-proxy`. `--check` fails if the files are stale
// (CI and the test suite use it).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tablePath = path.join(root, "scripts/link-commands.json");
const tsOut = path.join(root, "packages/shared/src/guestCommandTable.ts");
const rsOut = path.join(root, "apps/desktop/src-tauri/src/link/proxy_dispatch.rs");
const srcTauri = path.join(root, "apps/desktop/src-tauri/src");
const check = process.argv.includes("--check");

const table = JSON.parse(readFileSync(tablePath, "utf8"));
const categories = ["local", "view", "control", "edit", "custom", "blocked"];
const seen = new Map();
for (const category of categories) {
  for (const name of table[category] ?? []) {
    if (seen.has(name)) {
      throw new Error(`${name} is classified twice (${seen.get(name)} and ${category})`);
    }
    seen.set(name, category);
  }
}

// --- where each command lives: the generate_handler! list in lib.rs ---
const libRs = readFileSync(path.join(srcTauri, "lib.rs"), "utf8");
const handlerBlock = libRs.slice(libRs.indexOf("generate_handler!["));
const handlerPaths = new Map();
for (const match of handlerBlock.matchAll(/^\s*([a-z_][a-z0-9_:]*)::([a-z_0-9]+),\s*$/gm)) {
  handlerPaths.set(match[2], match[1]);
}

function moduleFile(modulePath) {
  const parts = modulePath.split("::");
  const base = path.join(srcTauri, ...parts);
  for (const candidate of [`${base}.rs`, path.join(base, "mod.rs")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no file for module ${modulePath}`);
}

/** Split on commas that are not inside <>, (), [] or {}. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("<([{".includes(char)) depth += 1;
    if (">)]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function parseCommand(name) {
  const modulePath = handlerPaths.get(name);
  if (!modulePath) throw new Error(`${name} is not registered in generate_handler!`);
  const source = readFileSync(moduleFile(modulePath), "utf8");
  const header = new RegExp(
    `(#\\[tauri::command[^\\]]*\\]\\s*(?:#\\[[^\\]]*\\]\\s*)*)pub\\s+(async\\s+)?fn\\s+${name}\\s*(<[^>]*>)?\\s*\\(`,
  );
  const match = header.exec(source);
  if (!match) throw new Error(`cannot find #[tauri::command] fn ${name} in ${modulePath}`);
  const attribute = match[1];
  const isAsync = Boolean(match[2]);
  const snakeArgs = /rename_all\s*=\s*"snake_case"/.test(attribute);
  // Parameter list: from after the "(" to its matching ")".
  let index = match.index + match[0].length;
  let depth = 1;
  let params = "";
  while (depth > 0) {
    const char = source[index++];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth > 0) params += char;
  }
  const afterParams = source.slice(index, source.indexOf("{", index));
  const returnMatch = /->\s*([\s\S]+?)\s*(where\b|$)/.exec(afterParams.trim());
  const returnType = returnMatch ? returnMatch[1].trim() : "()";

  const args = splitTopLevel(params).map((param) => {
    const colon = param.indexOf(":");
    const argName = param.slice(0, colon).trim().replace(/^mut\s+/, "");
    const type = param.slice(colon + 1).trim();
    if (/^(tauri::)?State\s*</.test(type)) return { kind: "state" };
    if (/^(tauri::)?AppHandle\b/.test(type)) return { kind: "app" };
    if (/\b(Window|WebviewWindow|Webview)\b|ipc::(Channel|Request)\b/.test(type)) {
      throw new Error(`${name}: parameter ${argName}: ${type} cannot be proxied`);
    }
    return { kind: "arg", key: snakeArgs ? argName : camel(argName) };
  });
  return { name, modulePath, isAsync, returnType, args };
}

function callExpression(command, appExpr) {
  const args = command.args
    .map((arg) => {
      if (arg.kind === "state") return `${appExpr}.state()`;
      if (arg.kind === "app") return `${appExpr}.clone()`;
      return `arg(&args, "${arg.key}")?`;
    })
    .join(", ");
  return `crate::${command.modulePath}::${command.name}(${args})`;
}

function convert(command, expr) {
  if (command.returnType === "()") return `{ ${expr}; Ok(Value::Null) }`;
  if (/^Result\s*</.test(command.returnType)) return `into_value_result(${expr})`;
  return `into_value(${expr})`;
}

const proxied = [];
for (const category of ["view", "control", "edit"]) {
  for (const name of table[category]) proxied.push({ ...parseCommand(name), category });
}

const access = { view: "View", control: "Control", edit: "Edit", custom: "Custom" };
const accessArms = ["view", "control", "edit", "custom"]
  .filter((category) => (table[category] ?? []).length)
  .map(
    (category) =>
      `        ${table[category].map((name) => `"${name}"`).join("\n        | ")} => Some(ProxyAccess::${access[category]}),`,
  )
  .join("\n");

const dispatchArms = proxied
  .map((command) => {
    if (command.isAsync) {
      return `        "${command.name}" => ${convert(command, `${callExpression(command, "app")}.await`)},`;
    }
    return [
      `        "${command.name}" => {`,
      `            let app = app.clone();`,
      `            tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {`,
      `                ${convert(command, callExpression(command, "app"))}`,
      `            })`,
      `            .await`,
      `            .map_err(|error| error.to_string())?`,
      `        }`,
    ].join("\n");
  })
  .join("\n");

const rust = `// @generated by scripts/generate-link-proxy.mjs from scripts/link-commands.json.
// Do not edit by hand: change the table and run \`npm run gen:link-proxy\`.
#![allow(clippy::all, unused_variables)]

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::proxy::{arg, into_value, into_value_result};

/// The minimum role a proxied command needs on the host. \`Custom\` ones are
/// handled by hand in \`proxy.rs\` before \`dispatch\`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyAccess {
    View,
    Control,
    Edit,
    Custom,
}

/// None: not a command a guest may run on the host (local to the guest,
/// blocked, or unknown).
pub fn access(command: &str) -> Option<ProxyAccess> {
    match command {
${accessArms}
        _ => None,
    }
}

/// Session events the host relays to its guests (mirror mode).
pub const EVENTS_TO_RELAY: &[&str] = &[
${table.events.map((name) => `    "${name}",`).join("\n")}
];

pub const PROXIED_COMMANDS: &[&str] = &[
${proxied.map((command) => `    "${command.name}",`).join("\n")}
];

/// Run a proxied command with the guest's arguments, exactly as the host's
/// own UI would through Tauri. The caller has already checked the role.
pub async fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    match command {
${dispatchArms}
        _ => Err(format!("notProxied:{command}")),
    }
}
`;

const list = (names) => names.map((name) => `  "${name}",`).join("\n");
const ts = `// @generated by scripts/generate-link-proxy.mjs from scripts/link-commands.json.
// Do not edit by hand: change the table and run \`npm run gen:link-proxy\`.

/** Network-session guest mirror: what each desktop command does on a guest. */
export type GuestCommandRoute = "local" | "view" | "control" | "edit" | "custom" | "blocked";

export const GUEST_COMMAND_ROUTES: Readonly<Record<string, GuestCommandRoute>> = {
${categories
  .flatMap((category) => (table[category] ?? []).map((name) => `  ${name}: "${category}",`))
  .join("\n")}
};

/** Session events relayed by the host; a guest listens to them under
 * \`link-mirror://<name>\`. */
export const GUEST_MIRRORED_EVENTS: ReadonlySet<string> = new Set([
${list(table.events)}
]);

/** Run on the guest's own device even in guest mode. */
export const GUEST_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
${list(table.local)}
]);
`;

function emit(file, content) {
  const current = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
  if (current === content) return false;
  if (check) {
    console.error(`stale: ${path.relative(root, file)} (run npm run gen:link-proxy)`);
    process.exitCode = 1;
    return true;
  }
  writeFileSync(file, content);
  console.log(`wrote ${path.relative(root, file)}`);
  return true;
}

emit(rsOut, rust);
emit(tsOut, ts);
