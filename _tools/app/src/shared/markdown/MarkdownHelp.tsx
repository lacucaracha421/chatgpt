import { QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import { Description } from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { MarkdownView } from "./MarkdownView";
import "./markdownHelp.css";

export const MARKDOWN_HELP_TITLE = "마크다운 도움말";
export const MARKDOWN_HELP_INTRO = "왼쪽처럼 쓰면 오른쪽처럼 보여요.";

/** One cheat-sheet row: the syntax as typed and a short Korean label. */
export const MARKDOWN_HELP_ROWS: ReadonlyArray<{ label: string; syntax: string; note?: string }> = [
  { label: "제목", syntax: "# 제목\n## 작은 제목", note: "# 개수로 크기 조절 (### 까지)" },
  { label: "굵게", syntax: "**굵게**" },
  { label: "기울임", syntax: "*기울임*" },
  { label: "목록", syntax: "- 항목\n1. 첫째" },
  { label: "할 일", syntax: "- [ ] 할 일\n- [x] 끝낸 일", note: "보기 화면에서 체크할 수 있어요" },
  { label: "링크", syntax: "[텍스트](https://example.com)", note: "http, https 주소만 연결돼요" },
  { label: "인용", syntax: "> 인용" },
  { label: "코드", syntax: "`코드`" },
  { label: "줄바꿈", syntax: "첫 줄\n둘째 줄\n\n새 문단", note: "Enter 한 번은 줄바꿈, 빈 줄은 문단 나누기" },
];

/** The cheat-sheet body; each example is rendered by the real renderer (links and checkboxes inert). */
export function MarkdownHelpContent() {
  return (
    <dl className="markdown-help">
      {MARKDOWN_HELP_ROWS.map((row) => (
        <div className="markdown-help__row" key={row.label}>
          <dt className="markdown-help__label">{row.label}{row.note && <small>{row.note}</small>}</dt>
          <dd className="markdown-help__syntax"><code>{row.syntax}</code></dd>
          <dd className="markdown-help__result"><MarkdownView source={row.syntax} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** PC editor wrapper: a quiet icon button that opens the cheat sheet in the common dialog. */
export function MarkdownHelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="icon" variant="ghost" aria-label={MARKDOWN_HELP_TITLE} onClick={() => setOpen(true)}>
        <QuestionMarkCircleIcon aria-hidden="true" width={20} height={20} />
      </Button>
      <Dialog open={open} title={MARKDOWN_HELP_TITLE} variant="medium" onClose={() => setOpen(false)}>
        <Description className="markdown-help__intro">{MARKDOWN_HELP_INTRO}</Description>
        <MarkdownHelpContent />
        <div className="ui-dialog__actions">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>닫기</Button>
        </div>
      </Dialog>
    </>
  );
}
