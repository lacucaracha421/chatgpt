/** Resolve scans through the same native ticket, digest validation and media cache as covers. */
export function mangaScanRequests(volumes: import('./collectionModel').CollectionVolume[], pickedId: string | null = null) {
  return Object.fromEntries(volumes.flatMap(volume => [volume.spineScan?.side, ...(volume.id === pickedId ? [volume.spineScan?.back] : [])].flatMap(id => id ? [[id, {id, original: false}]] : [])));
}
export function mangaScanVolumes<T extends {spineScan?:{side:string|null;back:string|null}|null}>(volumes:T[], urls:Record<string,string>):T[] {
  return volumes.map(volume => ({...volume, spineScan: volume.spineScan ? {
    side: volume.spineScan.side ? urls[volume.spineScan.side] ?? null : null,
    back: volume.spineScan.back ? urls[volume.spineScan.back] ?? null : null,
  } : null}));
}
