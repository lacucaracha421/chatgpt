/**
 * How much larger the 3D case and manga book are drawn before being scaled back (`--case-raster`, CollectionCase.css
 * and collectionWork.css). A face tilted in 3D is painted into a bitmap at its layout size and resampled as it turns,
 * so the PC (display scale 1-1.5) draws it at 2x to keep the cover as sharp as the flat image (user, 2026-10-17).
 * A high-density screen is sharp at 1x already, and 2x there quadruples the bitmaps the tablet turns every frame
 * (user, 2026-10-18: rotation stuttered on the Galaxy Tab at density 2.375). The aim is about three device pixels per
 * CSS pixel, in half steps between 1 and 2; sizes and positions on screen do not change.
 */
export function caseRaster(devicePixelRatio: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(1, Math.min(2, Math.floor(6 / ratio) / 2));
}

let watching = false;
/** Sets `--case-raster` on the document once, and again when the window moves to a screen of another density. */
export function watchCaseRaster() {
  if (watching || typeof window === "undefined" || typeof document === "undefined") return;
  watching = true;
  const apply = () => {
    const ratio = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty("--case-raster", String(caseRaster(ratio)));
    window.matchMedia?.(`(resolution: ${ratio}dppx)`)?.addEventListener?.("change", apply, { once: true });
  };
  apply();
}
