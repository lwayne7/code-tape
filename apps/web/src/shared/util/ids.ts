/**
 * Stable id generator. Prefers Web Crypto's randomUUID when available; falls back
 * to a counter + random suffix that is still globally unique within a session.
 */
let fallbackCounter = 0;

export function generateId(prefix = ""): string {
  const base = (() => {
    if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    fallbackCounter += 1;
    const random = Math.floor(Math.random() * 1_000_000).toString(36);
    return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${random}`;
  })();
  return prefix ? `${prefix}-${base}` : base;
}
