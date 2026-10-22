import "./collectionShelfRules.css";

/** Static row paint, shared by the PC and tablet, including rows awaiting artwork. */
export function ShelfMaterial() {
  return <span className="collection-shelf-material" aria-hidden="true">
    <span className="collection-shelf-material__back" />
    <span className="collection-shelf-material__plank" />
    <span className="collection-shelf-material__drop" />
  </span>;
}
