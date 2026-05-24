import type {
  IframeRunInput,
  IframeRunResult,
  IframeRuntime,
  RuntimeMessage,
} from "@/shared/recording-schema";
import { IFRAME_BOOT_SCRIPT } from "./iframeBoot";

export type IframeRuntimeOptions = {
  /** Override sandbox attributes; only "allow-scripts" is on by default. */
  sandboxFlags?: string;
};

const RUNTIME_SOURCE = "code-tape-runtime";

/**
 * Validate that an incoming postMessage genuinely came from our iframe runtime
 * and matches the current run. Exported so unit tests can poke at the predicate
 * without spinning up a real iframe.
 */
export function acceptRuntimeMessage(
  raw: unknown,
  expected: { runId: string | null; source: MessageEventSource | null },
  event: { source: MessageEventSource | null } = { source: null },
): RuntimeMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { source?: unknown; runId?: unknown; type?: unknown; payload?: unknown };
  if (m.source !== RUNTIME_SOURCE) return null;
  if (typeof m.runId !== "string") return null;
  if (expected.runId && m.runId !== expected.runId) return null;
  if (expected.source && event.source && event.source !== expected.source) return null;
  const validTypes = ["ready", "console", "error", "blocked-alert", "complete"];
  if (typeof m.type !== "string" || !validTypes.includes(m.type)) return null;
  if (!m.payload || typeof m.payload !== "object") return null;
  return m as RuntimeMessage;
}

function buildSrcDoc(bootScript: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>code-tape runtime</title></head><body><script>${bootScript}</script></body></html>`;
}

export function createIframeRuntime(options: IframeRuntimeOptions = {}): IframeRuntime {
  let iframe: HTMLIFrameElement | null = null;
  let host: HTMLElement | null = null;
  let messageHandler: ((event: MessageEvent) => void) | null = null;

  const sandboxFlags = options.sandboxFlags ?? "allow-scripts";

  const teardown = () => {
    if (messageHandler) window.removeEventListener("message", messageHandler);
    messageHandler = null;
    if (iframe && iframe.parentElement) iframe.parentElement.removeChild(iframe);
    iframe = null;
  };

  const ensureIframe = (): Promise<HTMLIFrameElement> => {
    if (!host) throw new Error("IframeRuntime: mount(host) must be called first");
    if (iframe) return Promise.resolve(iframe);
    const el = document.createElement("iframe");
    el.setAttribute("sandbox", sandboxFlags);
    el.setAttribute("title", "code-tape preview");
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.border = "0";
    el.srcdoc = buildSrcDoc(IFRAME_BOOT_SCRIPT);
    iframe = el;
    return new Promise((resolve) => {
      el.addEventListener("load", () => resolve(el), { once: true });
      host!.appendChild(el);
    });
  };

  return {
    async mount(target: HTMLElement) {
      host = target;
      await ensureIframe();
    },
    async run(input: IframeRunInput): Promise<IframeRunResult> {
      const frame = await ensureIframe();
      const stdout: string[] = [];
      const stderr: string[] = [];

      return new Promise<IframeRunResult>((resolve) => {
        let settled = false;
        const finish = (result: IframeRunResult) => {
          if (settled) return;
          settled = true;
          if (messageHandler) window.removeEventListener("message", messageHandler);
          messageHandler = null;
          clearTimeout(timer);
          resolve(result);
        };

        const timer = setTimeout(() => {
          finish({ runId: input.runId, status: "timeout", stdout, stderr });
        }, input.timeoutMs);

        messageHandler = (event: MessageEvent) => {
          const msg = acceptRuntimeMessage(
            event.data,
            { runId: input.runId, source: frame.contentWindow },
            { source: event.source },
          );
          if (!msg) return;
          switch (msg.type) {
            case "console":
              if (msg.payload.level === "error") stderr.push(msg.payload.args.join(" "));
              else stdout.push(msg.payload.args.join(" "));
              break;
            case "error":
              finish({
                runId: input.runId,
                status: "error",
                phase: "runtime",
                message: msg.payload.message,
                stack: msg.payload.stack,
                stdout,
                stderr,
              });
              break;
            case "blocked-alert":
              stderr.push(`[blocked] ${msg.payload.message}`);
              break;
            case "complete":
              finish({
                runId: input.runId,
                status: "complete",
                previewHtml: msg.payload.previewHtml,
                stdout,
                stderr,
              });
              break;
            case "ready":
              break;
          }
        };
        window.addEventListener("message", messageHandler);
        frame.contentWindow?.postMessage(
          { type: "init", runId: input.runId, code: input.compiledCode },
          "*",
        );
      });
    },
    async renderPreview(previewHtml: string): Promise<void> {
      const frame = await ensureIframe();
      const win = frame.contentWindow;
      if (!win) return;
      // For replay rendering we don't execute code — just inject the captured DOM.
      const doc = win.document;
      doc.open();
      doc.write(`<!doctype html><html><head><meta charset="utf-8"></head>${previewHtml}</html>`);
      doc.close();
    },
    reset() {
      if (iframe && host) {
        host.removeChild(iframe);
        iframe = null;
      }
    },
    destroy() {
      teardown();
      host = null;
    },
  };
}
