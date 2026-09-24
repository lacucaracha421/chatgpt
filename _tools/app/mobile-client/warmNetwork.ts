export type WarmConnection={type?:string;saveData?:boolean;addEventListener?(event:string,callback:()=>void):void;removeEventListener?(event:string,callback:()=>void):void};
export const warmConnection=()=>(navigator as Navigator & {connection?:WarmConnection}).connection;
/** Match thumbnail warm-up: unknown links are allowed; cellular/data-saving links pause. */
export function meteredConnection(){const value=warmConnection();return value?.type==='cellular'||value?.saveData===true;}
