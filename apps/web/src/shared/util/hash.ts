/**
 * SHA-256 hex digest helper backed by Web Crypto when available.
 *
 * 节点环境（vitest jsdom）默认有 globalThis.crypto.subtle；浏览器在 HTTPS / localhost
 * 下同样可用。fallback 仅在 subtle 缺失（例如某些旧设备）时启用，使用 FNV-1a 64-bit
 * 仅作完整性指纹（非密码学安全）。
 */
export async function sha256Hex(input: string): Promise<string> {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const data = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(digest));
  }
  return fnv1a64Hex(input);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fnv1a64Hex(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Stable, ordering-deterministic JSON for checksums. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}
