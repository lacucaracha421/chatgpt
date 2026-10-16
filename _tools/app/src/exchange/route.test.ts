import { expect, it } from "vitest";
import { blockRoute, routeWord } from "./route";

it("names direct routes and leaves the server path unmarked", () => {
  expect(routeWord("lan")).toBe("직접");
  expect(routeWord("tailscale")).toBe("Tailscale");
  expect(routeWord(undefined)).toBeNull();
  expect(routeWord(null)).toBeNull();
});

it("gives a block a route only when every entry travelled the same direct way", () => {
  expect(blockRoute(["lan", "lan"])).toBe("lan");
  expect(blockRoute(["tailscale"])).toBe("tailscale");
  expect(blockRoute(["lan", "tailscale"])).toBeNull();
  expect(blockRoute(["lan", undefined])).toBeNull();
  expect(blockRoute([undefined, undefined])).toBeNull();
  expect(blockRoute([])).toBeNull();
});
