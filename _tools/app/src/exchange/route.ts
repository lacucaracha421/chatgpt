/** How a direct transfer travelled. Absent means the server path, which stays unmarked. */
export type ExchangeRoute = "lan" | "tailscale";

const WORDS: Record<ExchangeRoute, string> = { lan: "직접", tailscale: "Tailscale" };

/** The word shown for a route; nothing for the server path. */
export function routeWord(route: ExchangeRoute | null | undefined): string | null {
  return route ? WORDS[route] : null;
}

/** A block's route: only when every entry travelled the same direct way (a batch that fell back mid-way shows nothing). */
export function blockRoute(routes: readonly (ExchangeRoute | null | undefined)[]): ExchangeRoute | null {
  const first = routes[0];
  return first && routes.every((route) => route === first) ? first : null;
}
