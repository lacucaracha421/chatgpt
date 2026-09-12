import type {ComponentType, SVGProps} from 'react';
import {Button} from '../src/shared/ui/Button';
export {Button};
export {Dialog} from '../src/shared/ui/Dialog';
export {Description as DialogDescription} from '@radix-ui/react-dialog';
export function IconButton({label, icon: Icon, onClick, disabled, active}: {label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; onClick(): void; disabled?: boolean; active?: boolean}) {
  return <Button size="icon" variant="ghost" aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}><Icon aria-hidden="true"/></Button>;
}
export function Mark() { return <svg className="brand-mark" viewBox="0 0 32 36" fill="none" aria-hidden="true"><path d="M3 7h5v23H3zM13 2h5v32h-5zM23 6h5v23h-5z" stroke="currentColor" strokeWidth="1.3"/></svg>; }
