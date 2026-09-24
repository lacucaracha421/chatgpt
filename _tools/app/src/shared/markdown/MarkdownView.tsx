import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline, type MarkdownList } from "./markdown";
import "./markdown.css";

export type MarkdownViewProps = {
  source: string;
  /** Opens an http(s) link outside the WebView. Without it, links are inert. */
  onOpenLink?: (href: string) => void;
  /** Called with the task item's source line index; the caller rewrites that line. Without it, checkboxes are read-only. */
  onToggleTask?: (lineIndex: number, checked: boolean) => void;
  className?: string;
};

type Handlers = Pick<MarkdownViewProps, "onOpenLink" | "onToggleTask">;

/** Renders Markdown as React elements only; no HTML string is ever injected. */
export function MarkdownView({ source, onOpenLink, onToggleTask, className }: MarkdownViewProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const handlers = { onOpenLink, onToggleTask };
  return <div className={`markdown${className ? ` ${className}` : ""}`}>{renderBlocks(blocks, handlers)}</div>;
}

function renderBlocks(blocks: MarkdownBlock[], handlers: Handlers): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index, handlers));
}

function renderBlock(block: MarkdownBlock, key: number, handlers: Handlers): ReactNode {
  switch (block.type) {
    case "heading": {
      const Heading = (["h1", "h2", "h3"] as const)[block.level - 1];
      return <Heading key={key}>{renderInlines(block.children, handlers)}</Heading>;
    }
    case "paragraph":
      return <p key={key}>{renderInlines(block.children, handlers)}</p>;
    case "codeBlock":
      return <pre key={key}><code>{block.text}</code></pre>;
    case "blockquote":
      return <blockquote key={key}>{renderBlocks(block.children, handlers)}</blockquote>;
    case "list":
      return renderList(block, key, handlers);
    case "hr":
      return <hr key={key} />;
  }
}

function renderList(list: MarkdownList, key: number, handlers: Handlers): ReactNode {
  const items = list.items.map((item) => {
    const content = renderInlines(item.children, handlers);
    const sublists = item.sublists.map((sub, index) => renderList(sub, index, handlers));
    if (item.checked === undefined) return <li key={item.line}>{content}{sublists}</li>;
    const { onToggleTask } = handlers;
    return (
      <li key={item.line} className="markdown__task">
        <label>
          <input
            type="checkbox"
            checked={item.checked}
            disabled={!onToggleTask}
            onChange={(event) => onToggleTask?.(item.line, event.currentTarget.checked)}
          />
          <span>{content}</span>
        </label>
        {sublists}
      </li>
    );
  });
  return list.ordered
    ? <ol key={key} start={list.start === 1 ? undefined : list.start}>{items}</ol>
    : <ul key={key}>{items}</ul>;
}

function renderInlines(nodes: MarkdownInline[], handlers: Handlers): ReactNode[] {
  return nodes.map((node, index) => renderInline(node, index, handlers));
}

function renderInline(node: MarkdownInline, key: number, handlers: Handlers): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "strong":
      return <strong key={key}>{renderInlines(node.children, handlers)}</strong>;
    case "em":
      return <em key={key}>{renderInlines(node.children, handlers)}</em>;
    case "code":
      return <code key={key}>{node.text}</code>;
    case "break":
      return <br key={key} />;
    case "link": {
      const { onOpenLink } = handlers;
      return (
        <a
          key={key}
          href={node.href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            // Never navigate inside the WebView; the host opens the link externally.
            event.preventDefault();
            onOpenLink?.(node.href);
          }}
        >
          {renderInlines(node.children, handlers)}
        </a>
      );
    }
  }
}
