// The picture of a mark: the canvas as it is drawn, nothing of the page's DOM over it (pins, panels, notes).
//
// A WebGL canvas made without `preserveDrawingBuffer` keeps its picture only until the browser shows it; a read after
// that gives an empty picture. So the frame is rendered and the canvas snapshotted in the same task: `renderNow()`,
// then `toBlob`, which copies the canvas when it is called and encodes later. The page opens no 2D context of its own
// (every graphics context stays in `gpu`); the store circles the picked pixel and tells an empty read-back from a
// picture (wallhammer-web/marks-store).

export interface CanvasCapture {
  /** The PNG as base64 without the `data:` prefix, or null. */
  png: string | null;
  /** Why there is no picture, when there is none. */
  note: string | null;
}

/** Renders a frame and snapshots the canvas in the same task; the encoding finishes later. */
export function captureCanvas(canvas: HTMLCanvasElement, renderNow: () => void): Promise<CanvasCapture> {
  return new Promise((resolve) => {
    try {
      renderNow();
      canvas.toBlob((blob) => {
        if (!blob) return resolve({ png: null, note: 'PNG encoding failed' });
        const reader = new FileReader();
        reader.onload = () => {
          const s = String(reader.result);
          resolve({ png: s.slice(s.indexOf(',') + 1), note: null });
        };
        reader.onerror = () => resolve({ png: null, note: 'PNG read failed' });
        reader.readAsDataURL(blob);
      }, 'image/png');
    } catch (e) {
      resolve({ png: null, note: `snapshot failed: ${String(e)}` });
    }
  });
}
