import { invoke } from "@tauri-apps/api/core";

/**
 * The Jable page of an AV work, built only from its stored product code (never from a title).
 * A code that is not plain letters, digits and hyphens gives no link. The Rust command checks the same shape again.
 */
export function jableUrl(productCode: string | null | undefined): string | null {
  const code = productCode?.trim().toLowerCase();
  return code && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(code) ? `https://jp.jable.tv/videos/${code}/` : null;
}

/** Opens the page in Brave (PC); the command falls back to the default browser when Brave is not installed. */
export function openInBrave(url: string): Promise<void> {
  return invoke("open_in_brave", { url });
}
