export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Let the browser start consuming the object URL before revoking it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function safeFilenameStem(title: string, fallbackId: string): string {
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
