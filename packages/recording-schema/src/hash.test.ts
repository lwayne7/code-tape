import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "./hash.js";

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HUNDRED_A_SHA256 = "2816597888e4a0d3a36b82b83316ab32680eb8f00f8cd3b904d681246d285a0e";

test("sha256Hex returns a real SHA-256 digest without Web Crypto subtle", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: undefined,
  });

  try {
    assert.equal(await sha256Hex(""), EMPTY_SHA256);
    assert.equal(await sha256Hex("abc"), ABC_SHA256);
    assert.equal(await sha256Hex("a".repeat(100)), HUNDRED_A_SHA256);
    assert.equal((await sha256Hex("abc")).length, 64);
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    }
  }
});
