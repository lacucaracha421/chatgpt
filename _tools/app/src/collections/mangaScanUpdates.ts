import { useEffect, useRef, useState } from "react";
import type { CollectionVolume, LibraryGateway } from "../library/types";

/** Only re-read visible PC shelves containing the ISBN whose derived images changed. */
export function useMangaScanRevision(gateway: LibraryGateway, volumes: CollectionVolume[] | null) {
  const current = useRef(volumes); current.current = volumes;
  const [revision, setRevision] = useState(0);
  useEffect(() => gateway.subscribeMangaScansChanged?.(isbn => {
    if (current.current?.some(volume => volume.isbn13 === isbn)) setRevision(value => value + 1);
  }), [gateway]);
  return revision;
}
