import {useState, type ReactNode} from 'react';
import {InformationCircleIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
import {BottomSheet} from './BottomSheet';
import './tabletHelp.css';

/** DESIGN.md §12 Words: a necessary explanation sits behind one ⓘ and opens in a sheet, never as an always-visible paragraph. */
export function TabletHelp({title, children}: {title: string; children: ReactNode}) {
  const [open, setOpen] = useState(false);
  return <>
    <IconButton label={`${title} 설명`} icon={InformationCircleIcon} onClick={() => setOpen(true)}/>
    {open && <BottomSheet title={title} onClose={() => setOpen(false)}><div className="tablet-help">{children}</div></BottomSheet>}
  </>;
}
