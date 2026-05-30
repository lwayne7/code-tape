import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RECORDING_SCHEMA_VERSION, type RecordingPackageV1 } from "@code-tape/recording-schema";
import { canonicalStringify, sha256Hex } from "@code-tape/recording-schema/hash";
import { createDemoRequestHandler, createDemoRuntime } from "../demoServer.js";

test("demo request handler serves cloud API before static SPA fallback", async () => {
  const webRoot = await makeWebRoot();
  const handler = createDemoRequestHandler({
    webRoot,
    createRequestId: () => "req-demo-api",
  });

  const apiResponse = await handler(
    new Request("http://localhost/api/recordings", {
      method: "GET",
      headers: { "x-owner-token": "owner-demo" },
    }),
  );

  assert.equal(apiResponse.status, 200);
  assert.equal(apiResponse.headers.get("content-type"), "application/json");
  assert.deepEqual(await apiResponse.json(), { items: [], nextCursor: null });

  const spaResponse = await handler(new Request("http://localhost/replays/cloud-1"));

  assert.equal(spaResponse.status, 200);
  assert.match(spaResponse.headers.get("content-type") ?? "", /^text\/html/u);
  assert.equal(await spaResponse.text(), "<!doctype html><div id=\"root\"></div>");
});

test("demo request handler validates completed uploads for immediate cloud playback", async () => {
  const webRoot = await makeWebRoot();
  const handler = createDemoRequestHandler({
    webRoot,
    createRequestId: () => "req-demo-upload",
  });
  const pkg = await makePackage();
  const createSessionRequest = await makeCreateSessionRequest(pkg);

  const createResponse = await handler(
    new Request("http://localhost/api/recordings/upload-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-demo",
      },
      body: JSON.stringify(createSessionRequest),
    }),
  );

  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as {
    sessionId: string;
    recordingId: string;
    uploadTargets: Array<{ kind: string; url: string; headers: Record<string, string> }>;
  };
  assert.ok(created.uploadTargets.every((target) => target.url.startsWith("/dev/object-storage/uploads/")));

  for (const target of created.uploadTargets) {
    const uploadResponse = await handler(
      new Request(new URL(target.url, "http://localhost"), {
        method: "PUT",
        headers: target.headers,
        body: assetBody(pkg, target.kind),
      }),
    );
    assert.equal(uploadResponse.status, 204, `${target.kind} upload should succeed`);
  }

  const completeResponse = await handler(
    new Request(`http://localhost/api/recordings/upload-sessions/${created.sessionId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-owner-token": "owner-demo",
      },
      body: JSON.stringify({
        uploadedAssets: createSessionRequest.assets.map(({ kind, sha256, sizeBytes }) => ({
          kind,
          sha256,
          sizeBytes,
        })),
      }),
    }),
  );

  assert.equal(completeResponse.status, 200);

  const detailResponse = await handler(
    new Request(`http://localhost/api/recordings/${created.recordingId}`, {
      method: "GET",
      headers: { "x-owner-token": "owner-demo" },
    }),
  );
  const detail = (await detailResponse.json()) as { recording: { status: string } };

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.recording.status, "ready");
});

test("demo runtime server exposes the same-origin cloud API over HTTP", async () => {
  const runtime = createDemoRuntime({
    webRoot: await makeWebRoot(),
    createRequestId: () => "req-demo-server",
  });
  await listen(runtime.server);
  try {
    const response = await fetch(`http://127.0.0.1:${addressPort(runtime.server)}/api/recordings`, {
      headers: { "x-owner-token": "owner-demo" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], nextCursor: null });
  } finally {
    await closeServer(runtime.server);
    runtime.close();
  }
});

async function makeWebRoot(): Promise<string> {
  const webRoot = await mkdtemp(join(tmpdir(), "code-tape-demo-web-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><div id=\"root\"></div>");
  return webRoot;
}

async function makePackage(): Promise<RecordingPackageV1> {
  const code = "console.log('demo cloud')";
  const events: RecordingPackageV1["events"] = [
    {
      id: "event-1",
      seq: 1,
      timestampMs: 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: 1,
        code,
        contentHash: "content-hash-1",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    },
  ];
  const snapshots: RecordingPackageV1["snapshots"] = [
    {
      id: "snapshot-1",
      timestampMs: 0,
      eventSeq: 1,
      state: {
        editor: {
          code,
          language: "javascript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
          fontSize: 14,
          theme: "dark",
        },
        pointer: null,
        media: {
          microphoneEnabled: false,
          cameraEnabled: false,
          cameraPosition: { x: 0, y: 0 },
        },
        runtime: {
          status: "idle",
          stdout: [],
          stderr: [],
          previewHtml: null,
          errorMessage: null,
        },
      },
    },
  ];

  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-demo-cloud",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-30T00:00:00.000Z",
      completedAt: "2026-05-30T00:01:00.000Z",
      checksums: {
        eventsSha256: await sha256Hex(canonicalStringify(events)),
        snapshotsSha256: await sha256Hex(canonicalStringify(snapshots)),
      },
    },
    meta: {
      id: "rec-demo-cloud",
      title: "Demo Cloud Recording",
      createdAt: "2026-05-30T00:00:00.000Z",
      durationMs: 1000,
      appVersion: "0.0.0",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events,
    snapshots,
    media: null,
  };
}

async function makeCreateSessionRequest(pkg: RecordingPackageV1) {
  return {
    idempotencyKey: "idem-demo-cloud",
    localPackageId: pkg.manifest.packageId,
    title: pkg.meta.title,
    schemaVersion: pkg.schemaVersion,
    durationMs: pkg.meta.durationMs,
    initialLanguage: pkg.meta.initialLanguage,
    hasAudio: false,
    hasCamera: false,
    assets: await Promise.all([
      asset("manifest", pkg.manifest),
      asset("meta", pkg.meta),
      asset("events", pkg.events),
      asset("snapshots", pkg.snapshots),
    ]),
  };
}

async function asset(kind: "manifest" | "meta" | "events" | "snapshots", value: unknown) {
  const body = canonicalStringify(value);
  return {
    kind,
    sha256: await sha256Hex(body),
    sizeBytes: new TextEncoder().encode(body).byteLength,
    mimeType: "application/json",
  };
}

function assetBody(pkg: RecordingPackageV1, kind: string): string {
  switch (kind) {
    case "manifest":
      return canonicalStringify(pkg.manifest);
    case "meta":
      return canonicalStringify(pkg.meta);
    case "events":
      return canonicalStringify(pkg.events);
    case "snapshots":
      return canonicalStringify(pkg.snapshots);
    default:
      throw new Error(`unexpected upload target: ${kind}`);
  }
}

function listen(server: ReturnType<typeof createDemoRuntime>["server"]): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: ReturnType<typeof createDemoRuntime>["server"]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function addressPort(server: ReturnType<typeof createDemoRuntime>["server"]): number {
  const address = server.address();
  assert.notEqual(typeof address, "string");
  assert.ok(address);
  return (address as AddressInfo).port;
}
