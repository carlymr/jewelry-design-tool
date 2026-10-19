/** The markers for lots (GRA-36): a row that IS an unitemized lot, and a row
 * that was specified out of one. Shared by the inventory, the receipt
 * preview and the detail modal so a lot reads the same everywhere (the
 * counterpart of GenericBadge). */
export default function LotBadge({
  from,
  className = "",
}: {
  /** Mark a row as specified from a lot (rather than being one). */
  from?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded align-middle whitespace-nowrap ${
        from ? "bg-teal-50 text-teal-700" : "bg-teal-100 text-teal-800"
      } ${className}`}
      title={
        from
          ? `Specified from the lot "${from}"`
          : "Lot — an unsorted assortment; specify what it held as separate materials"
      }
    >
      {from ? "from lot" : "lot"}
    </span>
  );
}
