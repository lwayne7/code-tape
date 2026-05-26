import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRecordingStore } from "./recordingStore";
import { formatDurationMs } from "@/shared/time/duration";
import { IconButton, Popover, Tooltip } from "@/shared/ui";
import type { RecordingListItem, SaveResult } from "@/shared/recording-schema";

/**
 * RecordingLibraryPage — wires the RecordingRepository and lists completed
 * recordings.
 *
 * The card grid layout, search/filter UI, thumbnail rendering, and zip
 * import/export buttons are delegated to issue
 * `[P0] RecordingLibraryPage 列表 UI`. This shell guarantees the data layer
 * works and supplies the minimum entries (open, rename, delete, export).
 */
export function RecordingLibraryPage() {
  const navigate = useNavigate();
  const repository = useMemo(() => createRecordingStore(), []);
  const [items, setItems] = useState<RecordingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackDialog, setFeedbackDialog] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null);
  const [pendingRenameValue, setPendingRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [quota, setQuota] = useState<{ usageBytes: number; quotaBytes: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    let loadError: string | null = null;
    try {
      const list = await repository.list();
      setItems(list);
      setLoadError(null);
    } catch (err) {
      loadError = `读取失败：${(err as Error).message}`;
      setLoadError(loadError);
    } finally {
      setLoading(false);
    }
    if (loadError) {
      setTimeout(() => {
        setFeedbackDialog({ tone: "error", message: loadError as string });
      }, 0);
    }
  }, [repository]);

  const refreshQuota = useCallback(async () => {
    try {
      const estimate = await repository.estimateQuota();
      setQuota(estimate.quotaBytes > 0 ? estimate : null);
    } catch {
      setQuota(null);
    }
  }, [repository]);

  useEffect(() => {
    void refresh();
    void refreshQuota();
    void repository.sweep().catch(() => {
      // Sweep failure should not block library rendering.
    });
  }, [refresh, refreshQuota, repository]);

  const handleDelete = async (item: RecordingListItem) => {
    setBusyKey(`delete-${item.id}`);
    setDeleteError(null);
    try {
      await repository.remove(item.id);
      setPendingDeleteId(null);
      await refresh();
      await refreshQuota();
    } catch (err) {
      setDeleteError(`删除失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRenameStart = (item: RecordingListItem) => {
    setPendingRenameId(item.id);
    setPendingRenameValue(item.title);
    setRenameError(null);
  };

  const handleRenameCancel = () => {
    setPendingRenameId(null);
    setPendingRenameValue("");
    setRenameError(null);
  };

  const handleRenameSubmit = async (item: RecordingListItem) => {
    const nextTitle = pendingRenameValue.trim();
    if (!nextTitle) {
      setRenameError("标题不能为空。");
      return;
    }
    if (nextTitle === item.title) {
      handleRenameCancel();
      return;
    }
    setBusyKey(`rename-${item.id}`);
    try {
      await repository.rename(item.id, nextTitle);
      handleRenameCancel();
      await refresh();
    } catch (err) {
      setRenameError(`重命名失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleExport = async (item: RecordingListItem) => {
    setBusyKey(`export-${item.id}`);
    try {
      const zipBlob = await repository.exportZip(item.id);
      downloadBlob(zipBlob, `${safeFilenameStem(item.title, item.id)}.zip`);
      openFeedbackDialog("success", `已导出「${item.title}」。`);
    } catch (err) {
      openFeedbackDialog("error", `导出失败：${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const handleImportChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const imported = await repository.importZip(file);
      if (!imported.ok) {
        openFeedbackDialog("error", buildImportErrorMessage(imported));
        return;
      }
      openFeedbackDialog("success", `导入成功：${file.name}`);
      await refresh();
      await refreshQuota();
    } catch (err) {
      openFeedbackDialog("error", `导入失败：${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const quotaLabel = useMemo(() => {
    if (!quota || quota.quotaBytes <= 0) return null;
    const usageMB = (quota.usageBytes / (1024 * 1024)).toFixed(1);
    const quotaMB = (quota.quotaBytes / (1024 * 1024)).toFixed(1);
    const ratio = Math.round((quota.usageBytes / quota.quotaBytes) * 100);
    return `本地存储 ${usageMB} / ${quotaMB} MB (${ratio}%)`;
  }, [quota]);

  const canImport = !loading && !importing && busyKey === null;
  const showEmpty = !loading && !loadError && items.length === 0;

  const openImportPicker = () => {
    fileInputRef.current?.click();
  };

  const openFeedbackDialog = (tone: "success" | "error", message: string) => {
    setFeedbackDialog({ tone, message });
  };

  return (
    <div className="flex h-full flex-col gap-6 px-16 py-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-muted">code-tape</p>
          <h1 className="font-display text-3xl font-semibold">我的录制</h1>
          {quotaLabel ? <p className="mt-2 text-xs text-muted">{quotaLabel}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label="导入 zip 文件"
            onChange={(event) => void handleImportChange(event)}
          />
          <button
            type="button"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={openImportPicker}
            disabled={!canImport}
          >
            {importing ? "导入中…" : "导入 ZIP"}
          </button>
          <Link
            to="/record"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            新建录制
          </Link>
        </div>
      </header>

      {loadError ? (
        <div className="flex flex-col gap-3 rounded-md border border-danger/40 bg-danger/10 p-4">
          <p className="text-sm text-danger">{loadError}</p>
          <button
            type="button"
            className="w-fit rounded-md border border-danger/50 px-3 py-1.5 text-xs font-medium text-danger"
            onClick={() => void refresh()}
          >
            重试
          </button>
        </div>
      ) : showEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-surface/60 p-12 text-center">
          <p className="font-display text-lg">还没有录制</p>
          <p className="max-w-sm text-sm text-muted">
            点击右上角「新建录制」开始第一段代码讲解。
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface/60">
          <table className="w-full table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[18rem]" />
              <col className="w-[13rem]" />
              <col className="w-[12rem]" />
              <col className="w-[8rem]" />
              <col className="w-[8rem]" />
              <col className="w-[13rem]" />
            </colgroup>
            <thead className="bg-surface-raised text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 text-center font-medium">标题</th>
                <th className="px-4 py-3 text-left font-medium">创建时间</th>
                <th className="px-4 py-3 text-left font-medium">时长</th>
                <th className="px-4 py-3 text-left font-medium">语言</th>
                <th className="px-4 py-3 text-left font-medium">设备</th>
                <th className="px-4 py-3 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="px-4 py-3 text-center">
                    <EllipsisLink
                      to={`/replay/${item.id}`}
                      text={item.title}
                      className="font-medium text-foreground hover:underline"
                      align="center"
                    />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText text={formatCreatedAt(item.createdAt)} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText text={formatDurationMs(item.durationMs)} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText text={formatLanguage(item.initialLanguage)} />
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <EllipsisText
                      text={`${item.hasAudio ? "音频" : "无音频"} · ${item.hasCamera ? "摄像头" : "无摄像头"}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        icon={<span aria-hidden>▶</span>}
                        label="回放"
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/replay/${item.id}`)}
                        disabled={busyKey !== null || importing}
                      />
                      <Popover
                        open={pendingRenameId === item.id}
                        onOpenChange={(open) => {
                          if (open) {
                            handleRenameStart(item);
                          } else {
                            handleRenameCancel();
                          }
                        }}
                        align="end"
                        side="top"
                        width={300}
                        trigger={(
                          <IconButton
                            icon={<span aria-hidden>✎</span>}
                            label="重命名"
                            variant="ghost"
                            size="sm"
                            disabled={busyKey !== null || importing}
                          />
                        )}
                      >
                        <form
                          className="space-y-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleRenameSubmit(item);
                          }}
                        >
                          <p className="text-xs text-foreground">重命名「{item.title}」</p>
                          <input
                            value={pendingRenameId === item.id ? pendingRenameValue : item.title}
                            onChange={(event) => setPendingRenameValue(event.target.value)}
                            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-focus"
                            placeholder="输入新标题"
                            aria-label={`重命名 ${item.title}`}
                            autoFocus
                          />
                          {renameError && pendingRenameId === item.id ? (
                            <p className="text-[11px] text-danger">{renameError}</p>
                          ) : null}
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-1 text-xs text-muted"
                              onClick={handleRenameCancel}
                              disabled={busyKey === `rename-${item.id}`}
                            >
                              取消
                            </button>
                            <button
                              type="submit"
                              className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
                              disabled={busyKey === `rename-${item.id}`}
                            >
                              {busyKey === `rename-${item.id}` ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </form>
                      </Popover>
                      <IconButton
                        icon={<span aria-hidden>⇩</span>}
                        label="导出 ZIP"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleExport(item)}
                        disabled={busyKey !== null || importing}
                      />
                      <Popover
                        open={pendingDeleteId === item.id}
                        onOpenChange={(open) => {
                          setPendingDeleteId(open ? item.id : null);
                          if (!open) setDeleteError(null);
                        }}
                        align="end"
                        side="top"
                        width={260}
                        trigger={(
                          <IconButton
                            icon={<span aria-hidden>✕</span>}
                            label="删除"
                            variant="ghost"
                            size="sm"
                            disabled={busyKey !== null || importing}
                          />
                        )}
                      >
                        <div className="space-y-2">
                          <p className="text-xs text-foreground">确认删除「{item.title}」？</p>
                          <p className="text-[11px] text-muted">删除后不可恢复。</p>
                          {deleteError && pendingDeleteId === item.id ? (
                            <p className="text-[11px] text-danger">{deleteError}</p>
                          ) : null}
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-border px-2 py-1 text-xs text-muted"
                              onClick={() => {
                                setPendingDeleteId(null);
                                setDeleteError(null);
                              }}
                              disabled={busyKey === `delete-${item.id}`}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-danger/50 bg-danger/10 px-2 py-1 text-xs text-danger"
                              onClick={() => void handleDelete(item)}
                              disabled={busyKey === `delete-${item.id}`}
                            >
                              {busyKey === `delete-${item.id}` ? "删除中…" : "确认删除"}
                            </button>
                          </div>
                        </div>
                      </Popover>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm">
          <div
            role="status"
            aria-live="polite"
            className="w-full max-w-xs rounded-md border border-border bg-popover p-4 shadow-elevation-3"
          >
            <p className="text-sm text-foreground">加载中…</p>
          </div>
        </div>
      ) : null}
      {feedbackDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-md border border-border bg-popover p-4 shadow-elevation-3"
          >
            <p
              className={[
                "text-sm",
                feedbackDialog.tone === "error" ? "text-danger" : "text-foreground",
              ].join(" ")}
            >
              {feedbackDialog.message}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground"
                onClick={() => setFeedbackDialog(null)}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type EllipsisTextProps = {
  text: string;
  align?: "left" | "center" | "right";
  className?: string;
};

function EllipsisText({ text, align = "left", className = "" }: EllipsisTextProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const checkOverflow = () => {
      setOverflowing(node.scrollWidth > node.clientWidth);
    };
    checkOverflow();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(checkOverflow) : null;
    observer?.observe(node);
    window.addEventListener("resize", checkOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", checkOverflow);
    };
  }, [text]);

  const base = (
    <span
      ref={ref}
      className={[
        "block w-full truncate",
        align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left",
        className,
      ].join(" ")}
    >
      {text}
    </span>
  );

  if (!overflowing) return base;
  return (
    <Tooltip content={text} delayMs={80}>
      <span className="block w-full">{base}</span>
    </Tooltip>
  );
}

type EllipsisLinkProps = {
  to: string;
  text: string;
  align?: "left" | "center" | "right";
  className?: string;
};

function EllipsisLink({ to, text, align = "left", className = "" }: EllipsisLinkProps) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const checkOverflow = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    setOverflowing(node.scrollWidth > node.clientWidth + 1);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    checkOverflow();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(checkOverflow) : null;
    observer?.observe(node);
    window.addEventListener("resize", checkOverflow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", checkOverflow);
    };
  }, [checkOverflow, text]);

  const link = (
    <Link
      ref={ref}
      to={to}
      onMouseEnter={checkOverflow}
      onFocus={checkOverflow}
      className={[
        "inline-block max-w-full truncate align-middle",
        align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left",
        className,
      ].join(" ")}
    >
      {text}
    </Link>
  );

  if (!overflowing) return link;
  return (
    <Tooltip content={text} delayMs={80}>
      {link}
    </Tooltip>
  );
}

function buildImportErrorMessage(result: Extract<SaveResult, { ok: false }>): string {
  return `导入失败：${buildSaveResultError(result)}`;
}

function buildSaveResultError(result: Extract<SaveResult, { ok: false }>): string {
  if (result.reason === "validation-failed") {
    return `压缩包校验不通过（${result.message}）。`;
  }
  if (result.reason === "quota-exceeded") {
    return "本地存储空间不足，请清理旧录制后重试。";
  }
  if (result.reason === "media-write-failed") {
    return `媒体写入失败（${result.message}）。`;
  }
  return result.message;
}

function safeFilenameStem(title: string, fallbackId: string): string {
  const blockedChars = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);
  const normalized = [...title.trim()]
    .map((char) => {
      if (blockedChars.has(char)) return "_";
      if (char.charCodeAt(0) < 32) return "_";
      return char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return normalized || fallbackId;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke in a later macrotask so browsers can start consuming the download URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatLanguage(language: string): string {
  if (language === "javascript") return "JavaScript";
  if (language === "typescript") return "TypeScript";
  if (language === "python") return "Python";
  return language;
}
