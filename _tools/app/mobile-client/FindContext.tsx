import {createContext,useContext} from 'react';
import {MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
export const FindContext=createContext<(()=>void)|null>(null);
export function FindButton(){const open=useContext(FindContext);return open?<IconButton label="찾기" icon={MagnifyingGlassIcon} onClick={open}/>:null;}
