const cache = new Map<string, Promise<string | undefined>>();

/** Bright ink catches foil; a conservative face ellipse keeps the subject readable. */
export function luminanceMask(src: string): Promise<string | undefined> {
  if (cache.has(src)) return cache.get(src)!;
  const promise = new Promise<string | undefined>(resolve => {
    const image = new Image();
    const timer = setTimeout(() => resolve(undefined), 1800);
    image.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement("canvas"); canvas.width = 90; canvas.height = 126;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) { resolve(undefined); return; }
        const ratio = 63 / 88; let sx = 0, sy = 0, sw = image.width, sh = image.height;
        if (image.width / image.height > ratio) { sw = image.height * ratio; sx = (image.width - sw) / 2; }
        else { sh = image.width / ratio; sy = (image.height - sh) / 2; }
        context.drawImage(image, sx, sy, sw, sh, 0, 0, 90, 126);
        const data = context.getImageData(0, 0, 90, 126);
        for (let i = 0; i < 90 * 126; i++) {
          const luminance = (.299 * data.data[i * 4] + .587 * data.data[i * 4 + 1] + .114 * data.data[i * 4 + 2]) / 255;
          let value = Math.max(0, Math.min(1, (luminance - .42) / .4)); value = value * value * (3 - 2 * value);
          const x = (i % 90) / 90, y = Math.floor(i / 90) / 126;
          const ellipse = ((x - .5) / .22) ** 2 + ((y - .27) / .24) ** 2;
          value *= Math.max(0, Math.min(1, (ellipse - .6) / .8));
          data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = 255; data.data[i * 4 + 3] = value * 255;
        }
        context.putImageData(data, 0, 0); resolve(`url("${canvas.toDataURL("image/png")}")`);
      } catch { resolve(undefined); }
    };
    image.onerror = () => { clearTimeout(timer); resolve(undefined); }; image.src = src;
  });
  if (cache.size >= 48) cache.delete(cache.keys().next().value!);
  cache.set(src, promise); return promise;
}
