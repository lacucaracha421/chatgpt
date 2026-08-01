import type { ReactNode } from "react";

type AppShellProps = {
  sidebar: ReactNode;
  content: ReactNode;
  status: ReactNode;
};

export function AppShell({ sidebar, content, status }: AppShellProps) {
  return (
    <main className="app-shell" aria-label="Library workspace">
      <div className="app-shell__workspace">
        {sidebar}
        <div className="app-shell__content">{content}</div>
      </div>
      {status}
    </main>
  );
}
