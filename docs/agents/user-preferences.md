# User working preferences

Status: current. Portable preferences the user stated in earlier sessions, for any agent or machine (local, cloud, a new PC). Machine-specific setup, access details and personal notes stay out of the repository. Where a rule is already codified elsewhere, this page links to it instead of repeating it.

## Communication

- **Korean for every user-facing message**, including short status lines and the final report. Code identifiers, commands, paths and commit messages stay as they are (commit messages in English).
- Report in user-experience terms (see `AGENTS.md`); lead with anything waiting on the user.
- When the user criticises a screen, say whether that area was part of the current plan or an old, untouched area, and add untouched ones to the backlog.
- When guiding the user through commands they run themselves, reply to each pasted output with only the next commands; add one short warning only if something looks wrong.
- When several requests arrive in a row, record them in `docs/roadmap/lakomics-backlog.md`, keep one or two jobs running, and pick the next from the queue; do not start a job per message.
- If the host offers push notifications, send one short Korean line when a final report is ready or a decision/approval is needed, not for routine progress.
- Before planning, large idea generation or hard architecture decisions, say in one line that a higher reasoning effort would help; the user switches it by hand.

## Workers and runs

- Worker routing (user, 2026-10-08): design work → a Claude Opus subagent at high effort; everything else → the Codex worker `gpt-6.1-sol` at medium (see the host's instructions for the command). **If the Codex quota runs out, continue with a Claude Sonnet subagent at high effort and tell the user in the report.**
- Keep test runs short: compile check plus the directly related tests for small fixes; no tests for purely visual edits. Run the full desktop suite and `npm run mobile:test` once per batch **before every commit** — scoped checks alone have broken the other client before.
- Do not start a release build after every fix; build when the user asks or a batch is ready to try.
- Watch long background jobs (builds, test suites, workers) for errors and report failures immediately; never mask an exit code.

## Interface feel

- **No flash on change** and the rest of the shared UI rules: `DESIGN.md` §12 (keep old content until the new is ready, swap in one step; skeleton only on first load).
- **Nothing pops in from nothing.** Unless speed is the point (scrubbing, typing, rapid viewer navigation), new panels, sections, menus and tab content ease in (short fade/rise, roughly 150–250 ms, reduced motion respected); tab entrance motion plays on every visit.
- **Busy labels only after ~400 ms** ("~ 중" text such as 불러오는 중, 확인 중): quick work shows nothing; once shown, keep the label briefly so it never blinks. Use the shared delayed-busy helper.
- No coloured edge stripes for state, the type/spacing/badge foundation and Pretendard: `DESIGN.md` §12.
- PC is canonical; the tablet follows in the same round with shared components: `AGENTS.md`, `DESIGN.md` §12.
- Mockups are plain HTML under `docs/prototypes/<topic>-<date>/` loading the app's real `tokens.css`/`controls.css`; check the render before showing.

## Product usage

- The user rarely continues where they left off: no "이어 읽기 / 이어 보기 / On Deck" sections; prefer new arrivals, upcoming and attention items.
- 망가 is one-off reading: catalog bookmarks are a quick re-open shelf, not followed series; no new-chapter, follow or reading-progress features for 망가.
