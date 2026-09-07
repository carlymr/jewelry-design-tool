/** The one marker for a catalog-seeded generic finding (GRA-17), shared by
 * the inventory row, the palette card and the pricing extras picker so a
 * generic reads the same everywhere. */
export default function GenericBadge() {
  return (
    <span
      className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 align-middle"
      title="Generic finding — seeded from the built-in catalog, no stock tracked"
    >
      generic
    </span>
  );
}
