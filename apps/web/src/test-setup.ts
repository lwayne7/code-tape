import "@testing-library/jest-dom/vitest";

// jsdom 25 doesn't implement Blob.arrayBuffer()/stream(); polyfill with an
// in-process buffer so feature code that reads media bytes (packageBuilder,
// recordingStore export) works in tests. Real browsers continue to use native.
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  const OriginalBlob = Blob;
  const blobBytes = new WeakMap<Blob, Uint8Array>();
  // Wrap the constructor so every Blob created in tests remembers its source bytes.
  globalThis.Blob = class PatchedBlob extends OriginalBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts ?? [], options);
      const encoder = new TextEncoder();
      const chunks: Uint8Array[] = [];
      for (const part of parts ?? []) {
        if (part instanceof Uint8Array) chunks.push(part);
        else if (part instanceof ArrayBuffer) chunks.push(new Uint8Array(part));
        else if (typeof part === "string") chunks.push(encoder.encode(part));
        else if (part instanceof OriginalBlob && blobBytes.has(part)) {
          chunks.push(blobBytes.get(part)!);
        }
      }
      const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      blobBytes.set(this, merged);
    }
  } as unknown as typeof Blob;
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    const bytes = blobBytes.get(this) ?? new Uint8Array(0);
    return Promise.resolve(bytes.slice().buffer);
  };
}

if (typeof window !== "undefined" && !("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
