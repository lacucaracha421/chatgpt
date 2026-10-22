export function commandErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof Error) {
    return error.message.trim() || fallback;
  }
  const direct = messageField(error);
  if (direct) return direct;
  if (typeof error !== "string") return fallback;

  const text = error.trim();
  if (!text) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    const parsedMessage = messageField(parsed);
    if (parsedMessage) return parsedMessage;
    return typeof parsed === "string" ? parsed.trim() || fallback : fallback;
  } catch {
    return text;
  }
}

function messageField(value: unknown): string | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message.trim() || null;
  }
  return null;
}

/**
 * Whether the server (or the PC before sending) refused a queued cloud command batch outright.
 * Resending the same batch can never succeed, unlike a lost connection, a timeout, a sign-in
 * problem, a rate limit or a server error, which keep the batch queued for the next try.
 */
export function cloudCommandRefused(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "favoriteCharacterExists" || code === "cloud_object_key_conflict" || code === "invalid_cloud_response") return true;
  if (code !== "cloud_asset_registration_rejected") return false;
  const status = Number(/HTTP (\d{3})/.exec(messageField(error) ?? "")?.[1]);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
