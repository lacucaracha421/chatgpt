# Transfer route and firewall helper (TRANSFER-001 S6)

Status: proposal, 2026-10-16. Open `index.html` (PC, tablet iframe `tablet.html`, Home lines, word table). It loads the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `shared-surfaces.css`, `controls.css`, `chrome.css` and PC `exchange/exchange.css`; the tablet frame loads `mobile-client/mobile.css` and `mobile-client/exchange.css`. `page.css` holds only the mockup frame and the two NEW pieces (marked). `?state=blocked|public|failed|none` and `?help` open a given state.

Scope: two small additions to the existing 전송 screens. Nothing else in the layout changes. The user sees one 전송 screen. Server transfer is the baseline and stays unmarked.

## 1. Route word on rows (PC and tablet, shared rule)

Data: each outgoing/incoming/received row carries optional `route: "lan" | "tailscale"`; absent = server.

| Route | Word | Where |
| --- | --- | --- |
| `lan` | `직접` | who line of the block |
| `tailscale` | `Tailscale` | who line of the block |
| absent (server) | nothing | — |
| mixed inside one block (e.g. a batch that fell back mid-way) | nothing | — |

- Put the word in the block's who line, after the time and before `전달됨`: `이 PC · 21:12 · 직접 · 전달됨 ✓`, tablet `나 · 21:12 · 직접 · 전달됨 ✓`, arrivals `Galaxy Tab S9 · 21:12 · 파일 3개 · 직접`. One place per block, so photo strips (which have no file rows) get it too.
- Style: plain text, `color: var(--color-faint)` (one step quieter than the muted who line), same size. No icon, badge, border, underline or coloured edge. Class `exchange-route` on both clients.
- Put the word→text mapping in one shared module (e.g. `src/exchange/route.ts`: `routeWord(route): string | null` and `blockRoute(routes[]): route | null` returning a route only when every entry shares it). The tablet imports it (DESIGN §12 "Rules and wording ... always one shared module"); no tablet copy.
- A live block whose route becomes known later: the word fades in (opacity, 140 ms, `--ease-standard`; none under reduced motion). Rows loaded with a route render it at once. If a send falls back from direct to server, the word goes away in the same render as the state change (no separate blink).
- State wording for a direct send: the outgoing `uploading` label reads `보내는 중 N%` instead of `업로드 중 N%` when `route` is set (PC `outgoingLabel` in `ExchangeView.tsx`, tablet `exchangeModel.ts` view label). A direct send goes straight to `전달됨`; `대기 중 (받으면 삭제됨)` stays server-only. Incoming wording (`받는 중`) is unchanged.

Files: PC `_tools/app/src/exchange/ExchangeView.tsx` (`Block` who line, `outgoingLabel`), `exchangeStore.ts` (row types gain `route?`); tablet `_tools/app/mobile-client/Exchange.tsx` (who line), `exchangeModel.ts`/`useExchange.ts` (row type, label); CSS one rule each in `src/exchange/exchange.css` and `mobile-client/exchange.css`.

## 2. Home 전송 tile lines

`_tools/app/src/home/HomeTransfer.tsx` currently appends `서버` to every line through a tile-wide `route` prop (default `"server"`). Replace that prop with the per-line route: `TransferLine` (`homeTransferModel.ts`) gains `route` computed with the same shared `blockRoute`, and the trail reads `직접 · 21:12`, `Tailscale · 64%`, or just `21:12` / `받기 대기` for server (pending question 2). The route word uses `--color-faint` like the rows. No firewall UI on Home.

## 3. 직접 받기 block (PC only, Windows only)

Placement: top of the 전송 index foot (`exchange-index-foot` in `ExchangeView.tsx`), above `받은 파일 저장 위치`, separated by a 1px `--color-border` line. It sits with the other receive setting and, being at the top of a bottom-anchored foot, its removal never moves the folder lines. Not a banner, not in the timeline, not in the toolbar status, not on Home, not on the tablet.

Structure (shared pieces only): label `직접 받기` (existing `exchange-index-label`) with a ghost icon `Button` ⓘ at the right opening an `AnchoredPanel` popover; one meta line (`--type-meta`, `--color-muted`, `role="status"`); one `Button variant="secondary" size="sm"` with `ShieldCheckIcon` (16) — the shield is the Windows convention for "needs administrator".

### States

The firewall state comes from the native side in the exchange snapshot (e.g. `directReceive: "unknown" | "allowed" | "blocked" | "public" | "unsupported"`), so reopening 전송 shows the last known state at once without a re-check flash; a re-check keeps the old value until the new one arrives.

| State | Shown | Line | Button | ⓘ text |
| --- | --- | --- | --- | --- |
| `unknown` (not checked yet) | nothing | — | — | — |
| `allowed` | nothing | — | — | — |
| `unsupported` (not Windows, LAN listener/identity unavailable, or no paired device) | nothing | — | — | — |
| `blocked` | block | `지금은 서버를 거쳐 받음` | `방화벽 열기` | `같은 Wi-Fi나 Tailscale의 태블릿이 이 PC로 바로 보내려면 Windows 방화벽에서 한 번 허용해야 합니다. 개인 네트워크에서만 열리고 관리자 확인 창이 뜹니다. 열지 않아도 파일은 서버를 거쳐 그대로 받습니다.` |
| `public` (active network profile is Public, so the Private rule cannot help) | block | `공용 네트워크라 서버를 거쳐 받음` | none | `이 Wi-Fi가 Windows에서 공용 네트워크로 되어 있어 직접 받을 수 없습니다. 설정 › 네트워크 및 인터넷에서 개인 네트워크로 바꾸면 직접 받습니다. 바꾸지 않아도 서버를 거쳐 받습니다.` |
| opening (after click, UAC pending) | block | unchanged | disabled at once; label `여는 중` via the shared `BusyLabel`/`useDelayedBusy` with its default timing | — |
| opened | block, then gone | `✓ 열림` in `--color-success`; block face tints toward success (8%) | hidden label reverts | — |
| failed (rule not added) | block | `⚠ 방화벽을 열지 못함` in `--color-danger` | `다시 시도` | as `blocked` |
| UAC declined by the user | back to `blocked` silently | — | — | — |

### Behaviour

- No flash, no pop-in: `unknown` renders nothing (no skeleton, no placeholder). When a check first yields `blocked`/`public`, the block eases in (200 ms fade + 4 px rise, `--ease-standard`). After `opened`, it stays 1.2 s, then fades (140 ms) and collapses its height (200 ms); reduced motion removes it at once. Changing between `blocked`/`failed`/`public` swaps text in place.
- Busy label: use the shared helper as is (`BusyLabel` / `useDelayedBusy`, default 600 ms delay, 400 ms minimum visible); do not hand-roll a timer. The button is disabled immediately on click so a double click cannot start two UAC prompts.
- Success is shown in place (DESIGN §12 Toasts): no toast. Failure is the one red line plus `다시 시도`; details (netsh exit code) go to the log, not the screen.
- After `opened`, the native side re-checks and reports `allowed`; the next tablet→PC send then goes direct without any other UI change.
- Accessibility: ⓘ has `aria-label="직접 받기 도움말"`; the line is `role="status"`; no hover tooltips.

### Native notes for the implementer (not UI)

- The elevated action runs `netsh advfirewall firewall add rule` for inbound TCP 53318, `profile=private`, via `ShellExecuteW` with `runas` (one UAC prompt). Do not elevate the app itself.
- Detection must also treat an inbound **block** rule for the Lakomics executable as `blocked`: when the listener first binds, Windows may show its own firewall dialog, and dismissing it creates program block rules that override a port allow rule. The elevated helper should remove those Lakomics-program block rules in the same elevated call. Verify on a real Windows machine; this is not confirmed by source reading.
- Whether the Tailscale adapter is in the Private profile on the user's PC is unverified; if it is Public, Tailscale direct receive needs the same treatment.

## 4. Deliberately not added

- No "같은 Wi-Fi의 태블릿과 직접 연결됨" status line on PC, tablet or Home. The route is chosen per send, the tablet listens only while its app is open, and a live status would need constant probing and would go stale or flicker. The route word on each finished row already tells the user what happened.
- No route prediction in the drop veil or composer, no route filter, no route column, no speed numbers.
- No firewall message on the tablet; tablet→PC silently falls back to the server, and the fix lives on the PC.

## Checks for the implementation round

Visual-only parts need no new tests. Worth one unit test each: `blockRoute` (all-same vs mixed vs absent) and the direct `보내는 중` label. Native acceptance (UAC prompt, rule present, a real tablet→PC direct send, the `public` profile case) is a device check on Windows.
