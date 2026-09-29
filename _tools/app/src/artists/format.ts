type ArtistKeys = { keys: readonly string[] };

/** `@handle` for the first handle key, else the host of the first creator URL. */
export function artistHandle(artist: ArtistKeys): string | null {
  const handle = artist.keys.find((key) => !/^https?:\/\//i.test(key));
  if (handle) return /^\d+$/.test(handle) ? handle : `@${handle}`;
  const url = artist.keys[0];
  if (!url) return null;
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}
