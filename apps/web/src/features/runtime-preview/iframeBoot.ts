/**
 * Stringified iframe bootstrap script.
 *
 * Loaded as `<script type="module">` inside the sandboxed iframe. Responsibilities:
 *   - intercept console.{log,warn,error} and forward to the parent
 *   - block alert/confirm/prompt (return null) and report via blocked-alert
 *   - listen for `init` messages carrying user JS to evaluate
 *   - capture sync + async errors and post `error` events
 *   - on completion (Promise resolution or sync return), serialize document.body
 *     to a previewHtml string so the player can re-render it later
 *
 * This script never trusts message.source/origin — the parent validates that on
 * its side via IframeRuntime.acceptRuntimeMessage(). The script DOES verify that
 * messages it receives carry `type === "init"` and the correct `runId`, so a
 * second postMessage with a stale runId doesn't double-run.
 */
export const IFRAME_BOOT_SCRIPT = `
(function () {
  const RUNTIME_SOURCE = "code-tape-runtime";
  let currentRunId = null;

  function post(type, payload) {
    parent.postMessage({ source: RUNTIME_SOURCE, runId: currentRunId, type, payload }, "*");
  }

  function strArg(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
      return JSON.stringify(value);
    } catch (_e) {
      return String(value);
    }
  }

  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = function () {
    originalConsole.log.apply(console, arguments);
    post("console", { level: "log", args: Array.prototype.map.call(arguments, strArg) });
  };
  console.warn = function () {
    originalConsole.warn.apply(console, arguments);
    post("console", { level: "warn", args: Array.prototype.map.call(arguments, strArg) });
  };
  console.error = function () {
    originalConsole.error.apply(console, arguments);
    post("console", { level: "error", args: Array.prototype.map.call(arguments, strArg) });
  };

  window.alert = function (message) {
    post("blocked-alert", { message: String(message ?? "") });
    return undefined;
  };
  window.confirm = function () { post("blocked-alert", { message: "confirm()" }); return false; };
  window.prompt = function () { post("blocked-alert", { message: "prompt()" }); return null; };

  window.addEventListener("error", function (event) {
    post("error", { message: event.message || String(event.error || ""), stack: (event.error && event.error.stack) || undefined });
  });
  window.addEventListener("unhandledrejection", function (event) {
    const reason = event.reason || {};
    post("error", { message: reason.message || String(reason), stack: reason.stack });
  });

  window.addEventListener("message", async function (event) {
    const msg = event.data;
    if (!msg || msg.type !== "init") return;
    if (currentRunId && msg.runId === currentRunId) return; // ignore replays
    currentRunId = msg.runId;
    post("ready", {});
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(msg.code);
      const result = fn();
      if (result && typeof result.then === "function") await result;
      const previewHtml = document.body ? document.body.outerHTML : "";
      post("complete", { previewHtml });
    } catch (err) {
      post("error", { message: (err && err.message) || String(err), stack: err && err.stack });
    }
  });
})();
`;
