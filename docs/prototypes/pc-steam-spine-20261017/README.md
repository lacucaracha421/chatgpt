# PC spine: Steam template (2026-10-17)

Status: proposal. User request (2026-10-17): "PC는 책등 없댔잖아. 스팀 아이콘 붙이고 책등 디자인해줄 수 있어?" About 133 games are now owned as `PC (Microsoft Windows)`. A PC game without a LaunchBox spine image currently gets a blank grey spine with only its title (`.ins.bare`).

Open `index.html`. It shows A, the PC shelf with Switch, Switch 2 and PS5 next to three PC games and one private PC case, with a toggle for the black (proposed) or grey (current) PC plastic. B shows the same PC games as they look today. C is the smallest tablet shelf. D shows the large work-screen case, which you can rotate. E shows the spines flat at true size: 34×520, 18×224 and 12×150. The page loads the app's real `fonts.css`, `tokens.css`, `CaseMaterials.css`, `CollectionCase.css` and `LightCase.css`. `steam-spine.css` holds the new rules. `page.css` holds only the mockup frame and the stand-in cover art.

## Design

The PC template uses the existing `.tpl` structure (`t-head` / `t-band` / `t-foot`) shared with sw2, sw and ps5. The title and the developer keep their current type, size, position and ellipsis.

| Part | Spec |
| --- | --- |
| Head (`.t-head`) | `aspect-ratio: 96 / 176` (between Switch 96/92 and PS5 96/271). Ink `#0f1217`. The Steam mark is white, centred horizontally at 14% from the top, and 64% of the spine width. Below it, `PC` is set sideways (like the PS5 head's logo + "PS5"): Pretendard (`--font-ui`) 800, `calc(var(--cd) * .46)`, letter-spacing .08em, white, top at 58% of the head. |
| Band + foot | One continuous print, `linear-gradient(#1b2838 40%, #223a52)` (Steam client slate, darkening slightly toward the foot). There is no separate foot block and no coloured stripe. |
| Title | Unchanged `.spine-title` (`--font-spine`, 700, `--cd * .5`, white .92). |
| Developer (`.t-pub`) | Unchanged size, colour `#c7d5e0` (Steam secondary text) instead of pure white. |
| Plastic (`CASE_PLASTIC.pc`) | `rgba(16,18,22,.9)`, a black PC DVD keep case. Today `pc` shares the grey `other` tint `rgba(120,128,136,.38)`; `other` keeps it. |
| Privacy | No change: the spine and front show `case-mask` exactly like the other platforms (template never drawn). |

At the smallest tablet shelf (12 px spine) the mark is about 8 px and `PC` about 5.5 px. Both still read as the Steam head, as on the PS5 head at that size.

These colours are package print colours, like the existing `rgb(230,72,45)` / `#050505` template literals. They are not UI tokens.

## Files to touch (`_tools/app/src/collections/case/`)

1. **`marks/steam-mark.svg`** (new). Copy `steam-mark.svg` from this folder: a single white path (`viewBox 0 0 24 24`, the Simple Icons "steam" glyph, drawn from the known path because no icon package is installed locally). It is for the personal app only.
2. **`CollectionCase.css`**: add the four rules from `steam-spine.css` after the `.ps5` rules, changing the url to `url("./marks/steam-mark.svg")`.
3. **`CollectionCase.tsx`**
   - The template list appears twice: `spineInsertClass()` (line ~30) and `CaseSpine` (`const template = …`, line ~205). Add `"pc"` to both, ideally as one shared `const SPINE_TEMPLATES: CasePlatform[] = ["sw2", "sw", "ps5", "pc"]`.
   - Set `CASE_PLASTIC.pc` to `"rgba(16,18,22,.9)"`.
   - Update the `casePlatform()` mapping as described below.
4. **`CaseBack.css`** (optional, same round): add `.collection-case .case-back--pc { --back-band: #1b2838; }` so a generated back matches the spine. The back already prints `PC`.
5. **Tests** (`CollectionCase.test.tsx`)
   - Add `"pc"` to `it.each(["sw2", "sw", "ps5"])("draws the %s package blocks …")`. That test already checks for no `<img>` in the head; the mark is a CSS background.
   - Extend `derives the template from actual platform data` with the mapping cases below.
   - No CSS-text pins.

The tablet uses the same `CaseSpine`, `LightCase` and CSS through `mobile-client/CollectionShelf.tsx`, so it follows with no tablet-specific code. It needs a tablet build to show up there.

## `casePlatform()` mapping

The current rule `/\b(pc|windows|linux|mac|macos)\b|steam deck/i` already maps `PC (Microsoft Windows)`, `Linux`, `Mac` and `Steam Deck` to `pc`, so the 133 owned PC games get the new spine without a mapping change. A read-only audit of the active library (owned platforms and first-listed platforms) turned up three gaps:

| Platform string | Today | Proposed | Why |
| --- | --- | --- | --- |
| `PC (Microsoft Windows)`, `Windows`, `Linux`, `Mac`, `macOS`, `Steam Deck` | pc | pc | unchanged |
| `SteamVR` (1 owned), `Steam` | other | **pc** | Steam games |
| `MS-DOS` | other | **pc** | PC games (many sold on Steam) |
| `Windows Phone` (1 owned) | **pc** | other | phone, not PC |
| `PC Engine`, `PC-FX`, `NEC PC-8801`/`PC-9801` | **pc** | other | NEC consoles/computers would wrongly get the Steam mark |

```ts
const NOT_PC = /windows\s*phone|pc[\s-]?(engine|fx|8\d|9\d)|turbografx/i;
if (!NOT_PC.test(platform) && (/\b(pc|windows|linux|mac|macos|ms-dos)\b/i.test(platform) || /steam/i.test(platform))) return "pc";
```

Test additions: `casePlatform(null, "SteamVR") → "pc"`, `casePlatform("MS-DOS") → "pc"`, `casePlatform(null, "Windows Phone") → "other"`, `casePlatform("PC Engine") → "other"`, `casePlatform("NEC PC-9801") → "other"`, and the existing `PC (Microsoft Windows)` / `Mac` / `Linux` → `"pc"`.

As today, mapping still uses the owned platform first, then the first listed platform. Mac- and Linux-only games share the Steam template; the head still reads `PC`.

## Not changed

LaunchBox spine images still win over the template. The other platforms' templates stay as they are. The `other` grey case, open-tray media (PC stays a disc tray) and case sounds are unchanged. The darker plastic also darkens the PC tray interior (multiply), as it does for the red Switch 2 case.
