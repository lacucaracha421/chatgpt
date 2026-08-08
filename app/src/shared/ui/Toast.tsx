import type { PropsWithChildren } from "react";

export function Toast({ children }: PropsWithChildren) {
  return (
    <p className="ui-toast" role="status">
      {children}
    </p>
  );
}
