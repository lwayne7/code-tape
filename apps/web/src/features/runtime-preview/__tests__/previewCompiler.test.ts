import { describe, expect, it } from "vitest";
import { createPreviewCompiler } from "../previewCompiler";

describe("createPreviewCompiler", () => {
  it("passes javascript through unchanged", async () => {
    const compiler = createPreviewCompiler();
    const result = await compiler.compile("const x = 1; console.log(x);", "javascript");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toContain("const x = 1");
  });

  it("transpiles typescript via injected loader", async () => {
    const compiler = createPreviewCompiler({
      typescriptLoader: async () => ({
        transpileModule(source) {
          // pretend to strip type annotations
          return { outputText: source.replace(/: number/g, ""), diagnostics: [] };
        },
        ScriptTarget: { ES2020: 7 },
        ModuleKind: { ESNext: 99 },
      }),
    });
    const result = await compiler.compile("const x: number = 1;", "typescript");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("const x = 1;");
  });

  it("returns structured transpile error when the loader throws", async () => {
    const compiler = createPreviewCompiler({
      typescriptLoader: async () => {
        throw new Error("loader exploded");
      },
    });
    const result = await compiler.compile("const x: number = 1;", "typescript");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.phase).toBe("transpile");
      expect(result.message).toContain("loader exploded");
    }
  });

  it("returns structured error when the transpiler reports diagnostics", async () => {
    const compiler = createPreviewCompiler({
      typescriptLoader: async () => ({
        transpileModule() {
          return {
            outputText: "",
            diagnostics: [{ messageText: "Type 'string' is not assignable" }],
          };
        },
        ScriptTarget: { ES2020: 7 },
        ModuleKind: { ESNext: 99 },
      }),
    });
    const result = await compiler.compile("let n: number = 'oops';", "typescript");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("string");
  });
});
