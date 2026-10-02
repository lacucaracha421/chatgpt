import { describe, expect, it } from 'vitest';
import { appendToSection, deleteMemoSection, editItem, joinItem, makeSection, memoBody, memoItems, memoMode, memoSections, moveItem, moveMemoSection, parseMemo, pasteItems, removeItem, renameMemoSection, sectionCopy, splitItem, switchMode, toggleItem, TOP_SECTION, unmakeSection } from './memoModel';

const item = (body: string, index = 0) => memoItems(parseMemo(body))[index]!;
describe('memo mode and lossless parsing', () => {
  it.each([
    ['', 'text'], ['\n \n## 제목', 'text'], ['- [ ]', 'todo'], ['## 오늘\r\n* [X] 끝\r\n+ [ ] 시작\r\n', 'todo'],
    ['- [ ] 일\n설명', 'text'], ['```\n- [ ] 코드\n```', 'text'], ['~~~js\n## 코드 제목\n- [x] 코드\n~~~\n- [ ] 일', 'text'],
  ])('%j -> %s', (body, expected) => expect(memoMode(body)).toBe(expected));
  it('keeps blank rows, fence contents, duplicate titles and original line endings', () => {
    const body = '앞\r\n\r\n## 중복\n```\n# 코드\n- [X] 코드\n```\r## 중복\r끝\r\n';
    const doc = parseMemo(body);
    expect(memoBody(doc)).toBe(body);
    expect(memoSections(doc).map(section => section.title)).toEqual([null, '중복', '중복']);
    expect(memoItems(doc).map(item => item.text)).toContain('# 코드');
    expect(memoItems(doc).filter(item => item.task)).toHaveLength(0);
    expect(memoItems(parseMemo('첫\n\n'))).toHaveLength(3);
  });
});
describe('line operations', () => {
  it('edits only one line and toggles only its state marker, preserving byte-for-byte neighbors', () => {
    const doc = parseMemo('앞  \r\n## 제목\r\n  * [X]  원문 \r\n+ [ ] 뒤\n');
    const id = memoItems(doc)[1]!.id;
    expect(memoBody(toggleItem(doc, id))).toBe('앞  \r\n## 제목\r\n  * [ ]  원문 \r\n+ [ ] 뒤\n');
    expect(memoBody(editItem(doc, id, '수정 ', 'todo'))).toBe('앞  \r\n## 제목\r\n  * [X]  수정 \r\n+ [ ] 뒤\n');
    const plainDoc = parseMemo('a\r\nb\r\nc');
    expect(memoBody(editItem(plainDoc, plainDoc.lines[1]!.id, 'B', 'text'))).toBe('a\r\nB\r\nc');
  });
  it('splits at a selection, opens a task below a done task and joins/removes without crossing a heading', () => {
    const doc = parseMemo('## 제목\r\n- [x] abcd\r\n- [ ] 뒤');
    const id = memoItems(doc)[0]!.id;
    const next = splitItem(doc, id, 1, 3, 'todo');
    expect(memoBody(next)).toBe('## 제목\r\n- [x] a\r\n- [ ] d\r\n- [ ] 뒤');
    expect(joinItem(doc, id)).toBe(doc);
    // An open item never joins into a done one (they are shown apart); it joins the previous open item.
    expect(joinItem(next, `line-${doc.nextId}`, 'todo')).toBe(next);
    const last = memoItems(next).find(entry => entry.text === '뒤')!.id;
    expect(memoBody(joinItem(next, last, 'todo'))).toBe('## 제목\r\n- [x] a\r\n- [ ] d뒤');
    const empty = parseMemo('a\r\n');
    expect(memoBody(removeItem(empty, empty.lines[1]!.id))).toBe('a');
    expect(memoBody(removeItem(parseMemo('one'), item('one').id))).toBe('');
  });
  it('adds/appends at the open end before trailing done rows and exposes stable untouched row identities', () => {
    const doc = parseMemo('## A\n- [ ] one\n- [x] done\n## B\n- [ ] two');
    const a = memoSections(doc)[1]!;
    const next = appendToSection(doc, a.id, 'new', 'todo');
    expect(memoBody(next)).toBe('## A\n- [ ] one\n- [ ] new\n- [x] done\n## B\n- [ ] two');
    expect(next.lines.filter(line => doc.lines.some(old => old.id === line.id)).map(line => line.raw)).toEqual(doc.lines.map(line => line.raw));
    expect(memoBody(appendToSection(parseMemo(''), TOP_SECTION, 'tablet'))).toBe('tablet');
    expect(memoBody(appendToSection(parseMemo(''), TOP_SECTION))).toBe('\n');
  });
  it('moves items between sections and the untitled top, retaining done state and other raw lines', () => {
    const doc = parseMemo('- [ ] top\r\n## A\r\n* [X] done\r\n## B\r\n+ [ ] two');
    const sections = memoSections(doc); const id = sections[1]!.items[0]!.id;
    const next = moveItem(doc, id, sections[2]!.id, 'todo');
    expect(memoBody(next)).toBe('- [ ] top\r\n## A\r\n## B\r\n+ [ ] two\r\n* [X] done');
    expect(memoBody(moveItem(doc, id, TOP_SECTION, 'todo'))).toBe('- [ ] top\r\n* [X] done\r\n## A\r\n## B\r\n+ [ ] two');
    expect(moveItem(doc, id, sections[1]!.id)).toBe(doc);
  });
  it('makes/unmakes/renames/deletes and moves sections without glued final lines', () => {
    const doc = parseMemo('- [x] title\r\n- [ ] body');
    const made = makeSection(doc, doc.lines[0]!.id);
    expect(memoBody(made)).toBe('## title\r\n- [ ] body');
    expect(memoBody(unmakeSection(made, made.lines[0]!.id, 'todo'))).toBe('- [ ] title\r\n- [ ] body');
    expect(memoBody(renameMemoSection(made, made.lines[0]!.id, 'new'))).toBe('## new\r\n- [ ] body');
    expect(memoBody(deleteMemoSection(made, made.lines[0]!.id))).toBe('');
    const two = parseMemo('## A\na\n## B\nb');
    const moved = moveMemoSection(two, two.lines[2]!.id, 'up');
    expect(memoBody(moved)).toBe('## B\nb\n## A\na');
    expect(memoSections(moved).filter(section => section.heading).map(section => section.title)).toEqual(['B', 'A']);
  });
  it('pastes task states, preserves the prefix/suffix, and escapes headings as item text', () => {
    const doc = parseMemo('- [ ] ab\r\n- [x] untouched');
    const next = pasteItems(doc, doc.lines[0]!.id, 1, 1, 'ONE\n* [X] TWO\n## title', 'todo');
    expect(memoBody(next)).toBe('- [ ] aONE\r\n- [x] TWO\r\n- [ ] ## titleb\r\n- [x] untouched');
    const text = parseMemo('ab');
    const pasted = pasteItems(text, text.lines[0]!.id, 2, 2, '\n## title', 'text');
    expect(memoSections(pasted)).toHaveLength(1);
    expect(memoItems(pasted).map(item => item.text)).toEqual(['ab', '## title']);
  });
});
describe('mode switching and copying', () => {
  it('converts nonblank lines with bullet removal, preserves headings/task state, then drops markers in place', () => {
    const doc = parseMemo('## title\r\n- bullet\r\n* [X] done\r\n\r\n1. numbered\r\nplain');
    const todo = switchMode(doc, 'todo');
    expect(memoBody(todo)).toBe('## title\r\n- [ ] bullet\r\n* [X] done\r\n- [ ] numbered\r\n- [ ] plain');
    expect(memoMode(memoBody(todo))).toBe('todo');
    expect(memoBody(switchMode(todo, 'text'))).toBe('## title\r\nbullet\r\ndone\r\nnumbered\r\nplain');
    expect(sectionCopy(memoSections(todo)[1]!, 'todo')).toBe('- bullet\n- numbered\n- plain');
    expect(sectionCopy(memoSections(switchMode(todo, 'text'))[1]!, 'text')).toBe('bullet\ndone\nnumbered\nplain');
  });
  it('keeps an empty todo note in todo mode, including heading-only input and converted fences', () => {
    for (const body of ['', '\n\n', '## title']) expect(memoMode(memoBody(switchMode(parseMemo(body), 'todo')))).toBe('todo');
    expect(memoMode(memoBody(switchMode(parseMemo('```\n# heading\n- [x] code\n```'), 'todo')))).toBe('todo');
  });
});

it('uses the same fence boundary rules as splitSections, including indented closes', () => {
  const doc = parseMemo('```\n# code\n    ```\n## title\n- [ ] task');
  expect(memoSections(doc).map(section => section.title)).toEqual([null, 'title']);
  expect(memoItems(doc)[memoItems(doc).length - 1]).toMatchObject({ text: 'task', task: true });
});

it('keeps a pasted heading as an item when switching a todo to plain text', () => {
  const doc = parseMemo('- [ ] ## literal heading');
  const text = switchMode(doc, 'text');
  expect(memoItems(text).map(item => item.text)).toEqual(['## literal heading']);
  expect(memoSections(text).filter(section => section.heading)).toHaveLength(0);
});

it('ignores blank separators when copying/appending/joining todo items without changing them', () => {
  const doc = parseMemo('## A\n\n- [ ] first\n\n- [x] done\n');
  const section = memoSections(doc)[1]!;
  expect(sectionCopy(section, 'todo')).toBe('- first');
  expect(memoBody(appendToSection(doc, section.id, 'added', 'todo'))).toBe('## A\n\n- [ ] first\n- [ ] added\n\n- [x] done\n');
  expect(joinItem(doc, section.items[1]!.id, 'todo')).toBe(doc);
});

it('retains untouched identities when a save/undo supplies reordered or inserted lines', () => {
  const original = parseMemo('first\nsecond\nthird');
  const reordered = parseMemo('third\nfirst\nsecond', original);
  expect(reordered.lines.map(line => line.id)).toEqual([original.lines[2]!.id, original.lines[0]!.id, original.lines[1]!.id]);
  const inserted = parseMemo('first\nnew\nsecond\nthird', original);
  expect(inserted.lines[0]!.id).toBe(original.lines[0]!.id);
  expect(inserted.lines[2]!.id).toBe(original.lines[1]!.id);
  expect(new Set(inserted.lines.map(line => line.id)).size).toBe(4);
});

it('moves a last section/item without inventing a trailing empty row on reopen', () => {
  const doc = parseMemo('## A\na\n## B\nb');
  const moved = moveMemoSection(doc, doc.lines[2]!.id, 'up');
  expect(parseMemo(memoBody(moved)).lines.map(line => line.raw)).toEqual(moved.lines.map(line => line.raw));
  const itemMoved = moveItem(doc, doc.lines[3]!.id, doc.lines[0]!.id, 'text');
  expect(memoBody(itemMoved)).toBe('## A\na\nb\n## B');
  expect(parseMemo(memoBody(itemMoved)).lines.map(line => line.raw)).toEqual(itemMoved.lines.map(line => line.raw));
});
