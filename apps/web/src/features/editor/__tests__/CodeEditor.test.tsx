import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeEditorHandle } from "../CodeEditor";

const monacoMock = vi.hoisted(() => {
  class MockEditorWorker {}
  class MockTsWorker {}

  class MockModel {
    disposed = false;

    constructor(
      public value: string,
      public language: string,
    ) {}

    getValue() {
      return this.value;
    }

    setValue(next: string) {
      this.value = next;
    }

    dispose() {
      this.disposed = true;
    }
  }

  class MockEditor {
    disposed = false;
    commands: Array<{ keybinding: number; handler: () => void }> = [];
    updateOptions = vi.fn((nextOptions: Record<string, unknown>) => {
      Object.assign(this.options, nextOptions);
    });
    setValue = vi.fn((next: string) => {
      this.options.model.setValue(next);
    });
    setPosition = vi.fn();
    setSelection = vi.fn();
    setScrollTop = vi.fn();
    setScrollLeft = vi.fn();
    trigger = vi.fn();
    addCommand = vi.fn((keybinding: number, handler: () => void) => {
      this.commands.push({ keybinding, handler });
      return `command-${this.commands.length}`;
    });

    constructor(
      public host: HTMLElement,
      public options: Record<string, unknown> & { model: MockModel },
    ) {}

    getValue() {
      return this.options.model.getValue();
    }

    dispose() {
      this.disposed = true;
    }
  }

  const models: MockModel[] = [];
  const editors: MockEditor[] = [];
  const createModel = vi.fn((value: string, language: string) => {
    const model = new MockModel(value, language);
    models.push(model);
    return model;
  });
  const create = vi.fn((host: HTMLElement, options: Record<string, unknown> & { model: MockModel }) => {
    const editor = new MockEditor(host, options);
    editors.push(editor);
    return editor;
  });
  const defineTheme = vi.fn(() => {
    if (monacoMock.failDefineThemeCalls > 0) {
      monacoMock.failDefineThemeCalls -= 1;
      throw new Error("define theme failed");
    }
  });
  const setTheme = vi.fn();
  const setModelLanguage = vi.fn((model: MockModel, language: string) => {
    model.language = language;
  });

  return {
    MockEditorWorker,
    MockTsWorker,
    failEditorWorkerImports: 0,
    failDefineThemeCalls: 0,
    models,
    editors,
    editor: {
      create,
      createModel,
      defineTheme,
      setTheme,
      setModelLanguage,
    },
    KeyMod: {
      CtrlCmd: 1 << 11,
      Shift: 1 << 10,
      Alt: 1 << 9,
    },
    KeyCode: {
      Enter: 3,
      Slash: 85,
      KeyF: 36,
      KeyG: 37,
    },
  };
});

vi.mock("monaco-editor/esm/vs/editor/editor.api", () => ({
  editor: monacoMock.editor,
  KeyMod: monacoMock.KeyMod,
  KeyCode: monacoMock.KeyCode,
}));
vi.mock("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/language/typescript/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  get default() {
    if (monacoMock.failEditorWorkerImports > 0) {
      monacoMock.failEditorWorkerImports -= 1;
      throw new Error("editor worker import failed");
    }
    return monacoMock.MockEditorWorker;
  },
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: monacoMock.MockTsWorker,
}));

describe("CodeEditor", () => {
  beforeEach(() => {
    vi.resetModules();
    monacoMock.models.length = 0;
    monacoMock.editors.length = 0;
    monacoMock.failEditorWorkerImports = 0;
    monacoMock.failDefineThemeCalls = 0;
    monacoMock.editor.create.mockClear();
    monacoMock.editor.createModel.mockClear();
    monacoMock.editor.defineTheme.mockClear();
    monacoMock.editor.setTheme.mockClear();
    monacoMock.editor.setModelLanguage.mockClear();
    delete (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function runCommand(editor: { commands: Array<{ keybinding: number; handler: () => void }> }, keybinding: number) {
    const command = editor.commands.find((candidate) => candidate.keybinding === keybinding);
    if (!command) throw new Error(`Missing command for keybinding ${keybinding}`);
    command.handler();
  }

  it("lazy-loads Monaco, creates the editor with initial props, and exposes it", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const ref = createRef<CodeEditorHandle>();
    const onMount = vi.fn();

    render(
      <CodeEditor
        ref={ref}
        language="javascript"
        initialValue="const answer = 42;"
        fontSize={16}
        theme="dark"
        onMount={onMount}
      />,
    );

    expect(monacoMock.editor.create).not.toHaveBeenCalled();
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(monacoMock.editor.createModel).toHaveBeenCalledWith("const answer = 42;", "javascript");
    expect(monacoMock.editors[0].options).toEqual(
      expect.objectContaining({
        automaticLayout: true,
        fontSize: 16,
        model: monacoMock.models[0],
        theme: "code-tape-dark",
      }),
    );
    expect(ref.current?.getEditor()).toBe(monacoMock.editors[0]);
    expect(onMount).toHaveBeenCalledWith(monacoMock.editors[0]);
  });

  it("updates language, font size, and theme without rewriting initialValue", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { rerender } = render(
      <CodeEditor language="javascript" initialValue="const first = true;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const model = monacoMock.models[0];
    const editor = monacoMock.editors[0];
    model.value = "const userTyped = true;";

    await act(async () => {
      rerender(
        <CodeEditor
          language="typescript"
          initialValue="const overwritten = true;"
          fontSize={18}
          theme="light"
        />,
      );
    });

    expect(model.getValue()).toBe("const userTyped = true;");
    expect(monacoMock.editor.setModelLanguage).toHaveBeenCalledWith(model, "typescript");
    expect(editor.updateOptions).toHaveBeenCalledWith({ fontSize: 18 });
    expect(monacoMock.editor.setTheme).toHaveBeenCalledWith("code-tape-light");
  });

  it("applies controlled replay state without changing initialValue semantics", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { rerender } = render(
      <CodeEditor
        language="javascript"
        initialValue="const first = true;"
        value="const replay = 1;"
        fontSize={14}
        theme="dark"
        readOnly
        cursor={{ lineNumber: 2, column: 3 }}
        selection={null}
        scrollTop={120}
        scrollLeft={8}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    expect(editor.getValue()).toBe("const replay = 1;");
    expect(editor.options.readOnly).toBe(true);
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 3 });
    expect(editor.setScrollTop).toHaveBeenCalledWith(120);
    expect(editor.setScrollLeft).toHaveBeenCalledWith(8);

    await act(async () => {
      rerender(
        <CodeEditor
          language="javascript"
          initialValue="const ignored = true;"
          value="const replay = 2;"
          fontSize={14}
          theme="dark"
          readOnly={false}
          cursor={null}
          selection={{
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 5,
          }}
          scrollTop={240}
          scrollLeft={16}
        />,
      );
    });

    expect(editor.getValue()).toBe("const replay = 2;");
    expect(editor.setValue).toHaveBeenCalledWith("const replay = 2;");
    expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: false });
    expect(editor.setSelection).toHaveBeenCalledWith({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    });
    expect(editor.setScrollTop).toHaveBeenCalledWith(240);
    expect(editor.setScrollLeft).toHaveBeenCalledWith(16);
  });

  it("registers common editor shortcut commands", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const onCommand = vi.fn();
    render(
      <CodeEditor
        language="javascript"
        initialValue="console.log('shortcuts');"
        fontSize={14}
        theme="dark"
        onCommand={onCommand}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    runCommand(editor, monacoMock.KeyMod.CtrlCmd | monacoMock.KeyCode.Enter);
    runCommand(editor, monacoMock.KeyMod.Shift | monacoMock.KeyMod.Alt | monacoMock.KeyCode.KeyF);
    runCommand(editor, monacoMock.KeyMod.CtrlCmd | monacoMock.KeyCode.Slash);
    runCommand(editor, monacoMock.KeyMod.CtrlCmd | monacoMock.KeyCode.KeyG);

    expect(onCommand).toHaveBeenCalledWith("run");
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.formatDocument", null);
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.commentLine", null);
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.gotoLine", null);
  });

  it("configures JS/TS workers and disposes editor resources on unmount", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { unmount } = render(
      <CodeEditor language="typescript" initialValue="let value: number = 1;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    const environment = (globalThis as {
      MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
    }).MonacoEnvironment;
    expect(environment?.getWorker("", "javascript")).toBeInstanceOf(monacoMock.MockTsWorker);
    expect(environment?.getWorker("", "typescript")).toBeInstanceOf(monacoMock.MockTsWorker);
    expect(environment?.getWorker("", "editorWorkerService")).toBeInstanceOf(
      monacoMock.MockEditorWorker,
    );

    unmount();

    expect(monacoMock.editors[0].disposed).toBe(true);
    expect(monacoMock.models[0].disposed).toBe(true);
  });

  it("does not rewrite MonacoEnvironment after workers are configured", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const first = render(
      <CodeEditor language="javascript" initialValue="const first = 1;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const environment = (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
    first.unmount();

    render(<CodeEditor language="typescript" initialValue="const second = 2;" fontSize={14} theme="light" />);
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(2));

    expect((globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment).toBe(environment);
  });

  it("shows a load error and retries after a Monaco initialization failure", async () => {
    monacoMock.failDefineThemeCalls = 1;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { CodeEditor } = await import("../CodeEditor");
    const first = render(
      <CodeEditor language="javascript" initialValue="const first = 1;" fontSize={14} theme="dark" />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Code editor failed to load.");
    expect(monacoMock.editor.create).not.toHaveBeenCalled();
    first.unmount();

    render(<CodeEditor language="javascript" initialValue="const retry = 1;" fontSize={14} theme="dark" />);
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(consoleError).toHaveBeenCalledWith("Failed to initialize Monaco editor", expect.any(Error));
    consoleError.mockRestore();
  });

  it("retries after a worker import failure", async () => {
    monacoMock.failEditorWorkerImports = 1;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { CodeEditor } = await import("../CodeEditor");
    const first = render(
      <CodeEditor language="typescript" initialValue="const first = 1;" fontSize={14} theme="dark" />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Code editor failed to load.");
    first.unmount();

    render(<CodeEditor language="typescript" initialValue="const retry = 1;" fontSize={14} theme="dark" />);
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(consoleError).toHaveBeenCalledWith("Failed to initialize Monaco editor", expect.any(Error));
    consoleError.mockRestore();
  });
});
