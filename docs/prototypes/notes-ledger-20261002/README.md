# 메모 · 가계부 (2026-10-02)

Mockup for the 메모 and 가계부 redesign (backlog `PC-POLISH-20261002` items 10–11). Accepted by the user 2026-10-02 with one change: no quick-add field on the PC (write directly in the note); the tablet keeps it.

- 메모 has two modes per note, switched at the top without changing content: 글 (plain lines, no circles — ideas) and 할 일 (a done
  circle per line — feedback, shopping); the current checklist note kind merges into 할 일. Section chips appear only with two or more
  named sections; in 글 mode section copy copies the whole section text. Note kinds become 메모 (글/할 일), 가계부, 암호 메모.
- 메모: no Markdown; one editing surface (no read/edit split, caret at the end on open). Sections are blocks shown as title rows (stored as
  text so existing notes and the PC stay compatible); "섹션으로 만들기" replaces the current one-line pin. Section chips filter to one
  section; each line is an item with a done circle, done items fold into "완료 N"; "+ 추가" per section (and Enter at the end of an item); the tablet also has a quick-add field with a section
  picker (remembers the last); move an item to another section (PC: a ⇄ icon on hover, tablet long-press); section copy puts only the open items on the
  clipboard as a plain list; Backspace on an empty item joins upward and never deletes a section title.
- 가계부: summary row (예산 → 고정 → 쓴 돈 → 남은 돈) with a meter that overlays a chosen wishlist item; this month's upcoming charges as a
  dated strip; subscriptions with cycle tags (매달, N달마다, 1년 갱신, 처음 N달 무료, 해지 예약) and the next charge on the right (yearly also per
  month); a detail dialog for cycle, trial, price history, first charge, reminder and cancellation; wishlist with price, where, priority and
  target month, "이번 달에 사면 남는 돈" and 샀음 → spending entry; manual spending list with a one-line quick input. The current ledger model
  (Recurring every/unit/trial/until, Planned, entries) covers most of it; price history and reminders are new.
