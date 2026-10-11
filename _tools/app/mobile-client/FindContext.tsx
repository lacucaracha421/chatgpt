import {createContext,useContext} from 'react';
import {MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
export type ScreenFind={scope:string;run(query:string):void};
export const FindContext=createContext<((search?:ScreenFind)=>void)|null>(null);
export function FindButton({search}:{search?:ScreenFind}){const open=useContext(FindContext);return <IconButton label="찾기" icon={MagnifyingGlassIcon} onClick={()=>open?.(search)}/>;}
