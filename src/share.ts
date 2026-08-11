/**
 * Getting the wreckage out of the browser.
 *
 * `DestroyerEngine.snapshot()` flattens the visible carnage into a Blob; these
 * two helpers are the only things standing between that and a file the user can
 * keep. Both are deliberately best-effort — clipboard writes need a secure
 * context and a live user gesture, and the caller should fall back to the
 * download rather than treating a rejection as an error.
 */

/** Save a blob to disk under `filename`. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next task: revoking synchronously can beat the navigation
  // the click just scheduled, and the download silently fails.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Put a blob on the clipboard. Resolves false when the browser won't allow it. */
export async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

/** `ragekit-2026-08-04T12-00-00.png` — sortable and collision-free. */
export function snapshotFilename(ext = "png") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `ragekit-${stamp}.${ext}`;
}
