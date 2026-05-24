import { describe, expect, it } from "vitest";
import { createRecordingClock } from "../recordingClock";

function makeMockClock() {
  let wall = 1_000;
  const advance = (ms: number) => {
    wall += ms;
  };
  const clock = createRecordingClock({ nowProvider: () => wall });
  return { clock, advance };
}

describe("createRecordingClock", () => {
  it("starts at status=idle and now=0", () => {
    const { clock } = makeMockClock();
    expect(clock.status).toBe("idle");
    expect(clock.now()).toBe(0);
  });

  it("advances now() while running", () => {
    const { clock, advance } = makeMockClock();
    clock.start();
    advance(500);
    expect(clock.now()).toBe(500);
    advance(1500);
    expect(clock.now()).toBe(2000);
  });

  it("freezes now() while paused and excludes paused interval after resume", () => {
    const { clock, advance } = makeMockClock();
    clock.start();
    advance(1000);
    clock.pause();
    expect(clock.now()).toBe(1000);
    advance(5000);
    expect(clock.now()).toBe(1000);
    clock.resume();
    advance(2000);
    expect(clock.now()).toBe(3000);
  });

  it("freezes durationMs after stop", () => {
    const { clock, advance } = makeMockClock();
    clock.start();
    advance(2500);
    clock.stop();
    const stopped = clock.durationMs();
    advance(10_000);
    expect(clock.durationMs()).toBe(stopped);
    expect(clock.status).toBe("stopped");
  });

  it("ignores duplicate start/pause/resume calls", () => {
    const { clock, advance } = makeMockClock();
    clock.start();
    clock.start();
    advance(500);
    clock.pause();
    clock.pause();
    advance(500);
    clock.resume();
    clock.resume();
    advance(500);
    expect(clock.now()).toBe(1000);
  });

  it("subscribe receives status transitions", () => {
    const { clock } = makeMockClock();
    const received: string[] = [];
    const unsubscribe = clock.subscribe((s) => received.push(s));
    clock.start();
    clock.pause();
    clock.resume();
    clock.stop();
    unsubscribe();
    expect(received).toEqual(["running", "paused", "running", "stopped"]);
  });
});
