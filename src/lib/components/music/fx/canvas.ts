/**
 * Keeps a full-window canvas sized to the viewport at `scale` device pixels per CSS pixel (lower
 * is cheaper and blurrier). Returns a cleanup that stops following resizes.
 */
export function fitCanvas(canvas: HTMLCanvasElement, scale = () => Math.min(2, devicePixelRatio || 1)) {
  const resize = () => {
    const ratio = scale();
    canvas.width = Math.max(1, Math.round(innerWidth * ratio));
    canvas.height = Math.max(1, Math.round(innerHeight * ratio));
  };
  resize();
  addEventListener('resize', resize);
  return () => removeEventListener('resize', resize);
}

export type Box = { left: number; top: number; right: number; bottom: number };

/** The player's box in CSS pixels; a sliver at the bottom middle of the window when there is none. */
export function playerBox(): Box {
  const box = document.querySelector<HTMLElement>('[data-fx-player]')?.getBoundingClientRect();
  if (box?.width) return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  return { left: innerWidth / 2 - 1, top: innerHeight - 1, right: innerWidth / 2 + 1, bottom: innerHeight };
}
