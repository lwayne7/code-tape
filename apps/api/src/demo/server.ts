import { resolve } from "node:path";
import { createDemoRuntime } from "./demoServer.js";

const port = Number(process.env.PORT ?? "4173");
const host = process.env.HOST ?? "0.0.0.0";
const webRoot = resolve(process.env.CODE_TAPE_WEB_ROOT ?? "apps/web/dist");
const publicBaseUrl = process.env.CODE_TAPE_PUBLIC_BASE_URL ?? "";

const runtime = createDemoRuntime({ webRoot, publicBaseUrl });

runtime.server.listen(port, host, () => {
  const shownHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`code-tape demo server listening on http://${shownHost}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runtime.close();
    runtime.server.close(() => {
      process.exit(0);
    });
  });
}
