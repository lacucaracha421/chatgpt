import { useRef } from "react";
import { routeWord, type ExchangeRoute } from "./route";

/**
 * ` · 직접` / ` · Tailscale` in a block's who line (PC and tablet share it); nothing for the server.
 * A word that appears after the block was already shown fades in; one present from the start does not.
 */
export function RouteWord({ route }: { route: ExchangeRoute | null }) {
  const startedWithout = useRef(route === null);
  if (route === null) startedWithout.current = true;
  const word = routeWord(route);
  if (!word) return null;
  return <> · <span className={`exchange-route${startedWithout.current ? " is-new" : ""}`}>{word}</span></>;
}
