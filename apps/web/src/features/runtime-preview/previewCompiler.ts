import type { CompileLanguage, CompileResult, PreviewCompiler } from "@/shared/recording-schema";

export type PreviewCompilerOptions = {
  /** Inject a typescript module loader. Defaults to dynamic `import("typescript")`. */
  typescriptLoader?: () => Promise<TypeScriptModule>;
};

type TypeScriptModule = {
  transpileModule(input: string, options: {
    compilerOptions: {
      target: number;
      module: number;
      jsx?: number;
      esModuleInterop?: boolean;
    };
    reportDiagnostics?: boolean;
  }): { outputText: string; diagnostics?: Array<{ messageText: string | { messageText: string } }> };
  ScriptTarget: { ES2020: number };
  ModuleKind: { ESNext: number };
};

let tsModuleCache: TypeScriptModule | null = null;

async function defaultTypescriptLoader(): Promise<TypeScriptModule> {
  if (tsModuleCache) return tsModuleCache;
  // dynamic import keeps the ~60MB typescript module out of the initial bundle;
  // Vite's code-splitting carves it into its own chunk.
  const mod = (await import("typescript")) as unknown as { default?: TypeScriptModule } & TypeScriptModule;
  tsModuleCache = mod.default ?? mod;
  return tsModuleCache;
}

function flattenDiagnostic(messageText: string | { messageText: string }): string {
  if (typeof messageText === "string") return messageText;
  return messageText.messageText;
}

/**
 * PreviewCompiler — turns the editor source into runnable JavaScript.
 *
 * - JavaScript is passed through unchanged.
 * - TypeScript is transpiled via lazy-loaded `typescript`. Module/target are
 *   ESNext so the result runs inside the iframe sandbox's ES module loader.
 * - On transpile failure we return a structured error (no thrown exceptions),
 *   matching the IframeRuntime contract — the caller decides how to surface it.
 */
export function createPreviewCompiler(options: PreviewCompilerOptions = {}): PreviewCompiler {
  const loadTs = options.typescriptLoader ?? defaultTypescriptLoader;
  return {
    async compile(source: string, language: CompileLanguage): Promise<CompileResult> {
      if (language === "javascript") {
        return { ok: true, code: source, warnings: [] };
      }
      try {
        const ts = await loadTs();
        const result = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ESNext,
            esModuleInterop: true,
          },
          reportDiagnostics: true,
        });
        if (result.diagnostics && result.diagnostics.length > 0) {
          return {
            ok: false,
            phase: "transpile",
            message: result.diagnostics
              .map((d) => flattenDiagnostic(d.messageText))
              .join("; "),
          };
        }
        return { ok: true, code: result.outputText, warnings: [] };
      } catch (err) {
        return {
          ok: false,
          phase: "transpile",
          message: (err as Error).message,
          stack: (err as Error).stack,
        };
      }
    },
  };
}
