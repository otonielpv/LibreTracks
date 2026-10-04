// Evaluate JS in the LibreTracks WebView on an emulator through the Chrome
// DevTools Protocol (only debug APKs are debuggable). Used by run.sh.
//   node cdp.mjs '<expression returning a value or a promise>'
// Helper available in the expression: inv(cmd, args) -> Tauri invoke.
import { execSync } from "node:child_process";

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const ADB = sdk ? `${sdk}/platform-tools/adb` : "adb";
const sockets = execSync(`"${ADB}" shell cat /proc/net/unix`).toString();
const socket = sockets.match(/@(webview_devtools_remote_\d+)/)?.[1];
if (!socket) {
  console.error("no webview devtools socket");
  process.exit(2);
}
execSync(`"${ADB}" forward tcp:9333 localabstract:${socket}`);
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = pages.find((p) => p.type === "page") ?? pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

const expression = `(async () => {
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {});
  return JSON.stringify(await (${process.argv[2]}));
})()`;
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, awaitPromise: true, returnByValue: true },
  }),
);
const reply = await new Promise((resolve) => {
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id === 1) resolve(data);
  };
});
ws.close();
const result = reply.result?.result;
if (reply.result?.exceptionDetails) {
  console.log("EXCEPTION", JSON.stringify(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails));
  process.exit(1);
}
console.log(result?.value ?? JSON.stringify(result));
