import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";

/** Shared Home wording and recovery action; the client owns the reserved frame. */
export function HomeReadState({ failed, empty = "배우 없음", onRetry, inline = false }: { failed: boolean; empty?: string; onRetry(): void; inline?: boolean }) {
  if (inline) return <span className="home-read-error"><span>불러오지 못했습니다.</span><Button variant="quiet" size="sm" onClick={onRetry}>다시 시도</Button></span>;
  return <EmptyState title={failed ? "불러오지 못했습니다." : empty}>
    {failed && <Button variant="ghost" size="sm" onClick={onRetry}>다시 시도</Button>}
  </EmptyState>;
}
