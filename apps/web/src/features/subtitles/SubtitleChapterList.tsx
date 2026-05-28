import { ListTree } from "lucide-react";
import type { SubtitleChapter } from "./types";
import { cn } from "@/shared/ui/utils/cn";

export type SubtitleChapterListProps = {
  chapters: SubtitleChapter[];
  currentTimeMs: number;
  onSeek(timeMs: number): void;
};

export function SubtitleChapterList({
  chapters,
  currentTimeMs,
  onSeek,
}: SubtitleChapterListProps) {
  if (chapters.length === 0) return null;

  return (
    <section aria-label="章节" className="mb-2 rounded-md border border-border bg-surface/40 p-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
        <ListTree aria-hidden size={14} className="text-primary" />
        <h3>章节</h3>
      </div>
      <div className="flex max-h-24 flex-col gap-1 overflow-y-auto pr-1">
        {chapters.map((chapter) => {
          const active = isActiveChapter(chapter, currentTimeMs);
          return (
            <button
              key={chapter.id}
              type="button"
              aria-current={active ? "true" : undefined}
              aria-label={`${chapter.title} ${formatSubtitleTime(chapter.startMs)}`}
              onClick={() => onSeek(chapter.startMs)}
              className={cn(
                "grid grid-cols-[4.5rem_1fr] gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-5",
                "transition-[background-color,color] duration-150 ease-out-soft",
                "hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                active ? "bg-surface-raised text-foreground" : "text-muted",
              )}
            >
              <span className="font-mono tabular-nums">{formatSubtitleTime(chapter.startMs)}</span>
              <span className="truncate text-foreground">{chapter.title}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function isActiveChapter(chapter: SubtitleChapter, currentTimeMs: number): boolean {
  return (
    currentTimeMs >= chapter.startMs &&
    (typeof chapter.endMs !== "number" || currentTimeMs < chapter.endMs)
  );
}

function formatSubtitleTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
