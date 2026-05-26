import { describe, expect, it } from "vitest";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import { createShortcutProducer } from "../shortcutProducer";

function setup(root: Window | HTMLElement = window) {
  const clock = createRecordingClock({ nowProvider: () => 1000 });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  clock.start();
  return { bus, clock, producer: createShortcutProducer({ bus, clock, getRoot: () => root }) };
}

function keydown(target: Window | HTMLElement, init: KeyboardEventInit & { timeStamp?: number }) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.timeStamp !== undefined) {
    Object.defineProperty(event, "timeStamp", { value: init.timeStamp });
  }
  target.dispatchEvent(event);
}

describe("createShortcutProducer", () => {
  it("emits friendly labels for known control shortcuts", () => {
    const { bus, producer } = setup();
    producer.start();

    keydown(window, { key: "s", metaKey: true });
    keydown(window, { key: "f", shiftKey: true, altKey: true, timeStamp: 600 });
    keydown(window, { key: "/", ctrlKey: true, timeStamp: 1200 });
    keydown(window, { key: "Enter", ctrlKey: true, timeStamp: 1800 });

    expect(bus.drain().map((event) => event.payload)).toEqual([
      { keys: ["Cmd", "S"], label: "Save", command: "save" },
      { keys: ["Shift", "Alt", "F"], label: "Format", command: "format" },
      { keys: ["Ctrl", "/"], label: "Comment", command: "comment" },
      { keys: ["Ctrl", "Enter"], label: "Run", command: "run" },
    ]);
  });

  it("ignores ordinary character input and bare modifier keys", () => {
    const { bus, producer } = setup();
    producer.start();

    keydown(window, { key: "a" });
    keydown(window, { key: "Shift", shiftKey: true });
    keydown(window, { key: "b", shiftKey: true });
    keydown(window, { key: "Escape" });

    expect(bus.drain()).toEqual([]);
  });

  it("dedupes the same shortcut within 500ms", () => {
    const { bus, producer } = setup();
    producer.start();

    keydown(window, { key: "z", metaKey: true, timeStamp: 1000 });
    keydown(window, { key: "z", metaKey: true, timeStamp: 1200 });
    keydown(window, { key: "z", metaKey: true, timeStamp: 1500 });
    keydown(window, { key: "z", metaKey: true, timeStamp: 1501 });

    expect(bus.drain().map((event) => event.payload)).toEqual([
      { keys: ["Cmd", "Z"], label: "Undo", command: "undo" },
      { keys: ["Cmd", "Z"], label: "Undo", command: "undo" },
    ]);
  });

  it("uses custom labels and falls back to a readable key label", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const clock = createRecordingClock({ nowProvider: () => 1000 });
    const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
    clock.start();
    const producer = createShortcutProducer({
      bus,
      clock,
      getRoot: () => root,
      resolveLabel: (event) => {
        if (event.key === "k") return { label: "Command Palette", command: "command-palette" };
        return null;
      },
    });
    producer.start();

    keydown(root, { key: "k", metaKey: true });
    keydown(root, { key: "p", ctrlKey: true, altKey: true, timeStamp: 600 });

    const payloads = bus.drain().map((event) => event.payload);
    expect(payloads).toEqual([
      { keys: ["Cmd", "K"], label: "Command Palette", command: "command-palette" },
      { keys: ["Ctrl", "Alt", "P"], label: "Ctrl + Alt + P" },
    ]);
    expect(payloads[1]).not.toHaveProperty("command");
  });

  it("handles root changes across pause and resume", () => {
    const { bus, clock } = setup();
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    let root: Window | HTMLElement | null = first;
    const producer = createShortcutProducer({ bus, clock, getRoot: () => root });
    producer.start();

    keydown(first, { key: "s", ctrlKey: true });
    producer.pause();
    keydown(first, { key: "Enter", ctrlKey: true, timeStamp: 600 });
    root = second;
    producer.resume();
    keydown(first, { key: "z", ctrlKey: true, timeStamp: 1200 });
    keydown(second, { key: "Enter", ctrlKey: true, timeStamp: 1800 });

    expect(bus.drain().map((event) => event.payload)).toEqual([
      { keys: ["Ctrl", "S"], label: "Save", command: "save" },
      { keys: ["Ctrl", "Enter"], label: "Run", command: "run" },
    ]);
  });

  it("collects shortcuts when root appears after start", () => {
    const { bus, clock } = setup();
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    let root: Window | HTMLElement | null = null;
    const producer = createShortcutProducer({ bus, clock, getRoot: () => root });
    producer.start();

    keydown(window, { key: "s", ctrlKey: true });
    root = rootElement;
    keydown(rootElement, { key: "s", ctrlKey: true, timeStamp: 600 });

    expect(bus.drain().map((event) => event.payload)).toEqual([
      { keys: ["Ctrl", "S"], label: "Save", command: "save" },
    ]);
  });

  it("collects shortcuts after active root changes without resume", () => {
    const { bus, clock } = setup();
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    let root: Window | HTMLElement | null = first;
    const producer = createShortcutProducer({ bus, clock, getRoot: () => root });
    producer.start();

    keydown(first, { key: "s", ctrlKey: true });
    root = second;
    keydown(second, { key: "Enter", ctrlKey: true, timeStamp: 600 });
    keydown(first, { key: "z", ctrlKey: true, timeStamp: 1200 });

    expect(bus.drain().map((event) => event.payload)).toEqual([
      { keys: ["Ctrl", "S"], label: "Save", command: "save" },
      { keys: ["Ctrl", "Enter"], label: "Run", command: "run" },
    ]);
  });

  it("stops current capture, restarts, and only dispose permanently disables shortcuts", () => {
    const { bus, producer } = setup();
    producer.start();

    producer.stop();
    keydown(window, { key: "s", ctrlKey: true });

    producer.start();
    keydown(window, { key: "Enter", ctrlKey: true, timeStamp: 600 });

    producer.dispose();
    keydown(window, { key: "z", ctrlKey: true, timeStamp: 1200 });

    expect(bus.drain().map((event) => event.payload)).toEqual([
      { keys: ["Ctrl", "Enter"], label: "Run", command: "run" },
    ]);
  });

  it("does not attach when getRoot returns null", () => {
    const { bus, clock } = setup();
    const producer = createShortcutProducer({ bus, clock, getRoot: () => null });
    producer.start();

    keydown(window, { key: "s", ctrlKey: true });

    expect(bus.drain()).toEqual([]);
  });
});
