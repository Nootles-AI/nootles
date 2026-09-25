/**
 * A document's body while it syncs, in the shape of the paragraphs that will
 * replace it. Deferred, it waits a beat before showing, so a page that is
 * already warm swaps straight to its text and never flashes it.
 */
export function BodySkeleton({ deferred = false }: { deferred?: boolean }) {
  return (
    <div
      className={`nt-body-skeleton min-h-[40vh]${deferred ? " is-deferred" : ""}`}
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="nt-skeleton h-4 w-full" />
      <div className="nt-skeleton h-4 w-11/12" />
      <div className="nt-skeleton h-4 w-full" />
      <div className="nt-skeleton h-4 w-3/5" />
      <div className="nt-skeleton mt-4 h-4 w-full" />
      <div className="nt-skeleton h-4 w-5/6" />
      <div className="nt-skeleton h-4 w-2/5" />
    </div>
  );
}
