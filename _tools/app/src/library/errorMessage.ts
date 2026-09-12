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
