# Settings › 자동 작업 (2026-10-27)

Status: proposal (design mockup). App source is unchanged. PC only; the tablet follows later.

User request: gather the app's big automatic updates and analyses in PC Settings, so each one can be checked at a glance and run by hand. Thirteen jobs are shown. Claude jobs are left out on purpose.

## Files

| File | What it is |
| --- | --- |
| `index.html` | A: the section at 1280 wide in the normal state. B: the same section in 절약 모드. C: the 만료분 비우기 confirm dialog. D: one row in every state. E: the 자주 쓰는 것 change. F: decisions and what moves where. `#only=part-B` (and so on) shows one part, for screenshots. In A, B and C the row buttons work: a run, 중지, 다시 시도, and the dialog's 취소 and 영구 삭제. |
| `page.css` | The mockup frame, plus the proposed job row (`settings-view__property--job`, marked NEW). |
| `jobs.js` | Stand-in data (now = 10.27 15:02) and the mockup behaviour. |

The page loads the app's real `fonts`, `tokens`, `shared-base`, `shared-surfaces`, `shared-toolbars`, `settings`, `shared-states`, `shared-management`, `controls` and `chrome` CSS. Rows, section labels, switches, quiet buttons, the dialog, the rail, the index slab and the titlebar are therefore the app's own. Checked by rendering in headless Edge, including a scripted run of the row buttons and the dialog. No native app check was done.

## Decisions

- **Where it lives:** a new Settings section, **자동 작업** (`ArrowPathIcon`), in second place right below 자주 쓰는 것. Thirteen rows are too long for 자주 쓰는 것. Spread over 카탈로그, 연결 and 라이브러리, they cannot be read at a glance. The section is a place to look rather than to configure, so it sits above 화면 and 라이브러리.
- **One owner per control:** 자동 작업 owns *whether and when* a job runs: the on/off switch, the catalog interval and 지금 실행. Each owning section keeps *what and where*: folders, the server address and keys, 넓은 폴더 인식, trash retention, and the backup restore list. No switch appears in two places. See part F for the full table of moves.
- **자주 쓰는 것 › 갱신:** its three rows (catalog, calendar, auto tags) become one row, `자동 작업 ›`. That row shows `실패 1 · 실행 중 1` only when something is failing or running, and only the failure count is red. No run button exists in two places.
- **Groups:** 실패 (only when a job has failed, at the top) · 새 정보 · 분석 · 준비 · 정리. A failed job leaves its group and rises into 실패. It eases in over 140 ms (height and opacity) and goes back to its group when a retry succeeds. When only some items fail, as with cloud `실패 4개`, the row stays where it is and only that count is red.
- **Row layout (fixed columns, so switches and buttons line up down the whole list):** name / last result (the remaining width) · cadence / next run (176 px, meta) · switch (40 px, empty when the job has none) · action (120 px, quiet button, right-aligned). The action verb fits the job: 지금 갱신, 지금 확인, 지금 가져오기, 지금 실행, 지금 받기, 지금 만들기, 지금 동기화, 지금 백업, 만료분 비우기. The next step replaces it when the job needs one: 다시 시도, 중지, 폴더 선택, 연결 설정. The two-line height matches the existing Settings rows.
- **States:** a running job shows `받는 중 1,204 / 3,000` with the status panel's grey 48×4 bar, and only when the total is known. A failed job shows a red `실패` word, the reason and the time, with 다시 시도. When a job waits, the cadence column names the reason: `절약 모드 / 대기 128장`, `꺼짐`, `5분마다` with `가져올 폴더 없음`, or `서버 연결 안 됨` with a disabled switch. A pending count reads `대기 12개 · 실패 4개`. Success is shown in place: the row tints briefly toward success and a check fades in. There is no success toast.
- **절약 모드:** heavy jobs pause: 게임 정보, 캐릭터 자동 분류, 유사 이미지 준비, 영상 미리보기 준비 and 카드 누끼 만들기. A running download stops where it is and keeps its bar (`끄면 이어서`). While 절약 모드 is on, one line with the real switch appears at the top of the section.
- **휴지통 자동 비우기:** 만료분 비우기 opens a destructive dialog, `기간이 지난 4개를 영구 삭제할까요?`. It shows two overlapping thumbnails, a line naming the scope (`30일 지난 것만 · 휴지통의 나머지 41개는 그대로`) and the button `영구 삭제`. With nothing expired, the button is disabled and the row reads `30일 지난 것 없음`. Emptying the whole trash stays in the trash screen.
- **Text and time:** times follow `displayDateTime`: `14:20` today, `어제 23:10` yesterday, and `10.25` otherwise. Tomorrow is written as a date, never `내일`. Busy words (`갱신 중…`) appear only after 400 ms, through the shared delayed-busy helper. The mockup's static images show them directly. Rows carry no explanations; the 준비 group has a single ⓘ.
- No coloured edge stripes, no ivory marks on rows and no per-row spinners. Red marks only failures and green only a just-finished run.

## Open questions for the user

1. Place: is a new section in second place right, or should it go after 카탈로그, or replace 자주 쓰는 것's 갱신 group with the full list?
2. Should 지금 실행 run once even in 절약 모드? The proposal says yes, because the user asked for it directly.
3. Should the switches move out of 카탈로그, 연결 and 라이브러리, as proposed (one owner)? The alternative is to mirror them in both places.
4. Should partial failures, such as cloud `실패 4개`, also rise into 실패? The proposal says no.
5. 휴지통 자동 비우기 has no on/off today: retention lives in the trash screen, and "never" stands for off. Should it get a switch here?

## Implementation notes

- The data needs one native read for all jobs (kind, state running/queued/paused/failed/idle, done/total, reason, last result and time, next run) plus a change event. This is the same activity list the 2026-10-13 status-panel proposal (`../jobs-and-todo-20261013/`) asked for; do not add polling per job.
- Add the row as a `SettingsRow` variant (or a small `JobRow` in `shared/ui/`) so the tablet can reuse it later.
