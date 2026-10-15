import { cardTiers, type CardData, type PackCover } from "./types";

// Temporary slice-1 fixture. Slice 3 replaces this module with server draws.
// Every pixel is procedural: no library files, remote URLs or saved state.
function demoArt(index: number, cutout = false) {
  const hue = index * 53 + 210;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 ${cutout ? 100 : 0} 600 840"><defs><linearGradient id="sky" x2=".3" y2="1"><stop stop-color="hsl(${hue},60%,40%)"/><stop offset="1" stop-color="#111426"/></linearGradient><linearGradient id="coat" x2=".8" y2="1"><stop stop-color="hsl(${hue + 30},80%,82%)"/><stop offset="1" stop-color="hsl(${hue},55%,32%)"/></linearGradient></defs>${cutout ? "" : `<rect width="600" height="840" fill="url(#sky)"/><circle cx="420" cy="170" r="110" fill="#fff2c7" opacity=".55"/>${Array.from({ length: 30 }, (_, i) => `<circle cx="${i * 97 % 600}" cy="${i * 137 % 840}" r="${i % 3 + 1}" fill="#eef7ff" opacity=".6"/>`).join("")}<path d="M0 620 140 330 240 570 400 300 600 610V840H0" fill="#141d38"/>`}
  <path d="M90 820 170 470Q300 380 430 470L510 820Z" fill="url(#coat)" stroke="#10182d" stroke-width="7"/><path d="M170 480 60 650 210 580M430 480 550 650 390 580" fill="url(#coat)" stroke="#10182d" stroke-width="7"/><path d="M230 395V475L300 530 370 475V395" fill="#e5bfa5"/><ellipse cx="300" cy="300" rx="104" ry="140" fill="#f4d6be"/><path d="M188 355Q140 120 300 116Q470 120 410 370L365 235 310 285 250 225Z" fill="hsl(${hue},40%,22%)" stroke="#10182d" stroke-width="8"/><path d="M230 316 265 310M335 310 370 316" stroke="#253857" stroke-width="10" stroke-linecap="round"/><path d="M280 376Q300 387 320 376" fill="none" stroke="#b47c77" stroke-width="4"/><path d="M190 510 300 620 410 510 360 780H240Z" fill="#18213a"/><path d="m300 540 24 40-24 35-24-35Z" fill="#e8c47c"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let fixture: { cards: CardData[]; cover: PackCover } | undefined;
export function demoDeck() {
  if (fixture) return fixture;
  const names = ["새벽의 루나", "은빛 항해자", "별의 기록자", "밤의 수호자", "황금 날개", "별빛의 아리아"];
  const colors = ["#6d739d", "#447daa", "#687eac", "#8e6cae", "#b98a44", "#9577bd"];
  const cards = cardTiers.map((tier, index): CardData => ({ id: `DEMO-${index + 1}`, characterName: names[index], seriesName: "상상의 별자리", tier, artUrl: demoArt(index), artWidth: 600, artHeight: 840, cutoutUrl: index >= 3 ? demoArt(index, true) : undefined, tint: colors[index], count: index + 1, level: Math.min(5, index + 1), serial: index === 4 ? "No. 012 / 100" : index === 5 ? "No. 1 / 1" : undefined, isNew: index !== 1 }));
  // A separate cover illustration set, unrelated to the fixture draw order.
  fixture = { cards, cover: { imageUrls: Array.from({ length: 7 }, (_, i) => demoArt(i + 10)), centreCutoutUrl: demoArt(18, true) } };
  return fixture;
}
