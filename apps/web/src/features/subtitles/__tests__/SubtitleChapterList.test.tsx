import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SubtitleChapterList } from "../SubtitleChapterList";

describe("SubtitleChapterList", () => {
  it("renders generated chapters and seeks to the clicked chapter start time", () => {
    const onSeek = vi.fn();

    render(
      <SubtitleChapterList
        chapters={[
          { id: "chapter-1", title: "问题分析", startMs: 0, endMs: 12_000 },
          { id: "chapter-2", title: "代码实现", startMs: 12_000 },
        ]}
        currentTimeMs={13_000}
        onSeek={onSeek}
      />,
    );

    expect(screen.getByRole("heading", { name: "章节" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /代码实现/ })).toHaveAttribute(
      "aria-current",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /问题分析/ }));

    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("renders nothing when there are no chapters", () => {
    const { container } = render(
      <SubtitleChapterList chapters={[]} currentTimeMs={0} onSeek={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
