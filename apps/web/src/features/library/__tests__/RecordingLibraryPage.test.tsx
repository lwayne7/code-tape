import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingListItem, RecordingRepository } from "@/shared/recording-schema";

const repositoryMocks = {
  saveDraft: vi.fn(),
  commit: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  exportZip: vi.fn(),
  importZip: vi.fn(),
  sweep: vi.fn(),
  estimateQuota: vi.fn(),
};

vi.mock("../recordingStore", () => ({
  createRecordingStore: () => repositoryMocks as unknown as RecordingRepository,
}));

import { RecordingLibraryPage } from "../RecordingLibraryPage";

const BASE_TITLE = "Two Sum \u8bb2\u89e3";
const BASE_ITEM: RecordingListItem = {
  id: "rec-1",
  title: BASE_TITLE,
  createdAt: "2026-05-24T08:00:00.000Z",
  durationMs: 12_000,
  ownerId: null,
  creatorInfo: null,
  initialLanguage: "typescript",
  hasAudio: true,
  hasCamera: false,
  thumbnailBlobId: null,
};

function renderPage() {
  render(
    <MemoryRouter>
      <RecordingLibraryPage />
    </MemoryRouter>,
  );
}

describe("RecordingLibraryPage", () => {
  beforeEach(() => {
    Object.values(repositoryMocks).forEach((fn) => fn.mockReset());
    repositoryMocks.list.mockResolvedValue([]);
    repositoryMocks.sweep.mockResolvedValue({ removedDrafts: 0, removedBlobs: 0 });
    repositoryMocks.estimateQuota.mockResolvedValue({ usageBytes: 0, quotaBytes: 0 });
    repositoryMocks.rename.mockResolvedValue(undefined);
    repositoryMocks.remove.mockResolvedValue(undefined);
    repositoryMocks.exportZip.mockResolvedValue(new Blob(["zip"], { type: "application/zip" }));
    repositoryMocks.importZip.mockResolvedValue({ ok: true, recordingId: "rec-new" });

    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        writable: true,
        value: vi.fn(() => "blob:mock"),
      });
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        writable: true,
        value: vi.fn(),
      });
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows loading dialog first, then empty state", async () => {
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("\u52a0\u8f7d\u4e2d");
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));
    expect(await screen.findByText("\u8fd8\u6ca1\u6709\u5f55\u5236")).toBeInTheDocument();
  });

  it("keeps persistent load error state after closing load-failed dialog", async () => {
    repositoryMocks.list.mockRejectedValueOnce(new Error("idb read failed"));
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("\u52a0\u8f7d\u4e2d");
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "\u8bfb\u53d6\u5931\u8d25\uff1aidb read failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("\u8bfb\u53d6\u5931\u8d25\uff1aidb read failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "\u91cd\u8bd5" })).toBeInTheDocument();
    expect(screen.queryByText("\u8fd8\u6ca1\u6709\u5f55\u5236")).not.toBeInTheDocument();
  });

  it("renders recording row and replay link", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    expect(screen.getByRole("link", { name: BASE_TITLE })).toHaveAttribute(
      "href",
      expect.stringContaining("/replay/rec-1"),
    );
    expect(screen.getByText(/TypeScript/)).toBeInTheDocument();
    expect(screen.getByText(/\u97f3\u9891/)).toBeInTheDocument();
    expect(screen.getByText(/\u65e0\u6444\u50cf\u5934/)).toBeInTheDocument();
  });

  it("renames a recording and refreshes list", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u547d\u540d" }));
    fireEvent.change(screen.getByLabelText(`\u91cd\u547d\u540d ${BASE_TITLE}`), {
      target: { value: "Two Sum \u8fdb\u9636" },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58" }));

    await waitFor(() => {
      expect(repositoryMocks.rename).toHaveBeenCalledWith("rec-1", "Two Sum \u8fdb\u9636");
    });
    expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
  });

  it("rejects blank rename title without calling repository", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u547d\u540d" }));
    fireEvent.change(screen.getByLabelText(`\u91cd\u547d\u540d ${BASE_TITLE}`), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58" }));

    expect(await screen.findByText("\u6807\u9898\u4e0d\u80fd\u4e3a\u7a7a\u3002")).toBeInTheDocument();
    expect(repositoryMocks.rename).not.toHaveBeenCalled();
  });

  it("deletes a recording only after confirm", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5220\u9664" }));
    expect(repositoryMocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u5220\u9664" }));

    await waitFor(() => {
      expect(repositoryMocks.remove).toHaveBeenCalledWith("rec-1");
      expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps delete confirmation open when delete fails", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    repositoryMocks.remove.mockRejectedValueOnce(new Error("idb delete failed"));
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5220\u9664" }));
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u5220\u9664" }));

    expect(await screen.findByText("\u5220\u9664\u5931\u8d25\uff1aidb delete failed")).toBeInTheDocument();
    expect(screen.getByText(`\u786e\u8ba4\u5220\u9664\u300c${BASE_TITLE}\u300d\uff1f`)).toBeInTheDocument();
    expect(repositoryMocks.list).toHaveBeenCalledTimes(1);
  });

  it("exports a recording to zip", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5bfc\u51fa ZIP" }));

    await waitFor(() => {
      expect(repositoryMocks.exportZip).toHaveBeenCalledWith("rec-1");
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });
  });

  it("disables zip import while an item operation is busy", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    let finishExport: (blob: Blob) => void = () => {};
    repositoryMocks.exportZip.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          finishExport = resolve;
        }),
    );
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5bfc\u51fa ZIP" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "\u5bfc\u5165 ZIP" })).toBeDisabled();
    });

    finishExport(new Blob(["zip"], { type: "application/zip" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "\u5bfc\u5165 ZIP" })).not.toBeDisabled();
    });
  });

  it("shows export failure dialog", async () => {
    repositoryMocks.list.mockResolvedValue([BASE_ITEM]);
    repositoryMocks.exportZip.mockRejectedValueOnce(new Error("zip failed"));
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(screen.getByRole("button", { name: "\u5bfc\u51fa ZIP" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("\u5bfc\u51fa\u5931\u8d25\uff1azip failed");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("imports valid zip and refreshes list", async () => {
    repositoryMocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...BASE_ITEM, id: "rec-new", title: "\u5bfc\u5165\u6210\u529f\u6837\u4f8b" }]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const file = new File(["zip"], "valid.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("\u5bfc\u5165 zip \u6587\u4ef6"), { target: { files: [file] } });

    await waitFor(() => {
      expect(repositoryMocks.importZip).toHaveBeenCalledTimes(1);
      expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("\u5bfc\u5165\u6210\u529f\u6837\u4f8b")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("\u5bfc\u5165\u6210\u529f\uff1avalid.zip");
  });

  it("shows clear error dialog for invalid zip import", async () => {
    repositoryMocks.importZip.mockResolvedValueOnce({
      ok: false,
      reason: "validation-failed",
      message: "checksum-mismatch:events",
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const file = new File(["bad"], "invalid.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("\u5bfc\u5165 zip \u6587\u4ef6"), { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "\u5bfc\u5165\u5931\u8d25\uff1a\u538b\u7f29\u5305\u6821\u9a8c\u4e0d\u901a\u8fc7",
    );
  });

  it("shows quota guidance when zip import exceeds local storage", async () => {
    repositoryMocks.importZip.mockResolvedValueOnce({
      ok: false,
      reason: "quota-exceeded",
      message: "quota exceeded",
    });
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    const file = new File(["zip"], "large.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText("\u5bfc\u5165 zip \u6587\u4ef6"), { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "\u672c\u5730\u5b58\u50a8\u7a7a\u95f4\u4e0d\u8db3",
    );
    expect(repositoryMocks.list).toHaveBeenCalledTimes(1);
  });

  it("recovers list after load failure retry", async () => {
    repositoryMocks.list.mockRejectedValueOnce(new Error("idb read failed")).mockResolvedValueOnce([BASE_ITEM]);
    renderPage();
    await waitForElementToBeRemoved(() => screen.queryByRole("status"));

    fireEvent.click(await screen.findByRole("button", { name: "\u786e\u8ba4" }));
    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u8bd5" }));

    expect(await screen.findByRole("link", { name: BASE_TITLE })).toBeInTheDocument();
    expect(screen.queryByText("\u8bfb\u53d6\u5931\u8d25\uff1aidb read failed")).not.toBeInTheDocument();
    expect(repositoryMocks.list).toHaveBeenCalledTimes(2);
  });
});
