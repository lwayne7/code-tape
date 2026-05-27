import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Slider } from "../Slider";

describe("Slider", () => {
  it("labels the interactive slider thumb", () => {
    render(
      <Slider
        value={25}
        min={0}
        max={100}
        ariaLabel="播放进度"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("slider", { name: "播放进度" })).toBeEnabled();
  });
});
