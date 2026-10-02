# Card pack prototype (2026-10-02)

Throwaway prototype, not production code. Question: does opening a five-card pack of "Lakomics cards"
built on the Pokémon TCG card template feel fun, and which frame style fits? The user asked for the card
to follow the Pokémon card closely and for the feature to stand apart from the app's NieR-flavoured
design language, so this page does not load the app's tokens or shared controls.

Open `index.html` in a browser. Sample art is generated on a canvas; in the product each card is one
library asset (sensitive assets included, by the user's decision). Nothing is stored.

## Flow

1. **Shelf**: pick one of three packs (character set, artist set, 1-year-ago set).
2. **Pack**: drag the top strip to the right to tear it (or press 그냥 뜯기 / Enter).
3. **Reveal**: cards come one at a time, face down. The back's edge light hints at the rarity. Click to
   flip, click again to send the card to the tray. Slot 5 is the guaranteed rare slot.
4. **Result**: the five cards; click one for the detail view.
5. **Detail**: large card with pointer tilt and holo foil, flip to the back (뒤집기 / Space), ←/→ to
   move between the five cards, metadata beside it, 에셋 열기 and 좋아요 as stubs.

## Card anatomy (Pokémon mapping)

| Pokémon card | Lakomics card |
| --- | --- |
| Stage (Basic / Stage 1) | 캐릭터 / 작품 / 기록 (what the asset is attached to) |
| Name | character name, else work title, else a short asset name |
| HP + type symbol | MP (megapixels) + media type (그림 / 사진 / GIF / 영상) |
| Illustration window | the asset |
| Species line (No. · height · weight) | No. · set · resolution · file size |
| Attacks | 작가 and 출처 rows |
| Flavor text | tags and folder |
| Weakness / resistance / retreat | ♥ favorite · folder · album count |
| Illus. · set symbol · number / rarity | Illus. (creator) · set mark · number / set total · rarity mark |

Rarity: 일반 ● · 언커먼 ◆ · 레어 홀로 ★ (foil on the illustration only) · 풀아트 ★★ (image fills the card,
foil over the whole card) · 시크릿 ✦ (gold frame and gold foil). The product intent is that an asset's
rarity is fixed, so it comes out the same in every pack; the prototype re-rolls each time.

## Variants (`?variant=A|B|C`, bottom bar, keys 1/2/3)

- **A 클래식**: yellow border, type-coloured frame, cream information box. Closest to the original card.
- **B 모던**: silver border, type colour only as a header band, white information box.
- **C 풀아트**: every card uses the full-art layout with a black border; rarity only changes the foil.

## Not covered

Binder/collection of pulled cards, pack supply rules (daily, rewards for sorting), tablet gestures and
gyroscope tilt, real asset cropping (character region), and the holo performance budget on the PC
WebView. These are decisions for after the user picks a direction.
