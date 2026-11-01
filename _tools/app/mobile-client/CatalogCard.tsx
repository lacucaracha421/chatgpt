import {useRef,type ReactNode} from 'react';
import {useCardArrival,type CardArrival} from './motion';

/** Shared catalog card; optional actions are siblings so bookmarking never opens the work. */
export function CatalogCard({arriving,onArrived,disabled,onClick,children,action}:{arriving:boolean;onArrived():void;disabled:boolean;onClick():void;children(arrival:CardArrival):ReactNode;action?:ReactNode}){
  const host=useRef<HTMLButtonElement>(null),arrival=useCardArrival(host,arriving,onArrived,false);
  const card=<button ref={host} className="catalog-card" disabled={disabled} onClick={onClick}>{children(arrival)}</button>;
  return action?<div className="catalog-card-container">{card}{action}</div>:card;
}
