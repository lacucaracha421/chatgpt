import type { Plugin } from "vite";
import { fixtureMediaSize } from "./fixtures.ts";

function hash(input: string): number {
  let value = 2166136261;
  for (const character of input) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

function previewSvg(pathname: string): string {
  const { width, height, label } = fixtureMediaSize(pathname);
  const seed = hash(pathname);
  const hue = seed % 360;
  const secondHue = (hue + 38 + (seed % 74)) % 360;
  const circleX = 20 + (seed % 61);
  const circleY = 24 + ((seed >>> 7) % 51);
  const radius = 18 + ((seed >>> 13) % 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 52% 22%)"/><stop offset="1" stop-color="hsl(${secondHue} 58% 42%)"/></linearGradient></defs>
    <rect width="100" height="100" fill="url(#g)"/>
    <circle cx="${circleX}" cy="${circleY}" r="${radius}" fill="hsl(${(hue + 180) % 360} 72% 82% / .68)"/>
    <path d="M-8 92 Q28 ${38 + (seed % 25)} 108 78 L108 108 L-8 108Z" fill="hsl(${(secondHue + 120) % 360} 48% 18% / .76)"/>
    <path d="M-12 84 Q42 ${62 + (seed % 18)} 112 32" fill="none" stroke="white" stroke-opacity=".34" stroke-width="3.4"/>
    <text x="6" y="95" fill="white" fill-opacity=".68" font-family="system-ui,sans-serif" font-size="3.4">${escapeXml(label)}</text>
  </svg>`;
}

export function previewMediaPlugin(): Plugin {
  return {
    name: "lakomics-preview-media",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://preview.local");
        if (!url.pathname.startsWith("/preview-media/")) { next(); return; }
        response.statusCode = 200;
        response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        response.setHeader("Cache-Control", "public, max-age=3600");
        response.end(previewSvg(url.pathname));
      });
    },
  };
}
