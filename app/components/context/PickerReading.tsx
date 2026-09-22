import { ProgressBar } from "../notion/Progress";

/**
 * The import's wait in a picker's size: the same bar, and the words only once
 * something is being fetched — while the connection is still being asked
 * after, there is nothing yet to name.
 */
export function PickerReading({ label, words }: { label: string; words?: string }) {
  return (
    <div className="nt-picker-reading" role="status" aria-label={label}>
      <ProgressBar label={label} />
      {words && <p aria-hidden>{words}</p>}
    </div>
  );
}
