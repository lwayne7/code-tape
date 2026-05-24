import { describe, expect, it } from "vitest";
import { normalizeRouterBasename } from "../routerBase";

describe("normalizeRouterBasename", () => {
  it("omits a basename for local root builds", () => {
    expect(normalizeRouterBasename("/")).toBeUndefined();
  });

  it("normalizes the GitHub Pages base without a trailing slash", () => {
    expect(normalizeRouterBasename("/code-tape/")).toBe("/code-tape");
  });
});
