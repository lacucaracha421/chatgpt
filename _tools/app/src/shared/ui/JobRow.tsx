import type { ReactNode } from "react";

/** Settings job columns stay aligned even when a job has no switch or next run. */
export function JobRow({ name, status, cadence, next, toggle, action, state, completed, children }: {
  name: string; status: ReactNode; cadence: ReactNode; next?: ReactNode;
  toggle?: ReactNode; action: ReactNode; state: string; completed?: boolean; children?: ReactNode;
}) {
  return <dl className={`settings-view__property auto-job${completed ? " is-done" : ""}`} data-state={state}>
    <dt><span>{name}</span></dt>
    <dd className="settings-view__status">{status}</dd>
    <dd className="auto-job__cadence">{cadence}</dd>
    <dd className="auto-job__next">{next}</dd>
    <dd className="auto-job__switch">{toggle}</dd>
    <dd className="auto-job__action">{action}</dd>
    {children}
  </dl>;
}
