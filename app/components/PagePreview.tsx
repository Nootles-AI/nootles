import type { PreviewLine } from "@/convex/preview";

/**
 * A project's first page, drawn small enough to recognise but not to read.
 *
 * Stylised rather than a literal scaled render: the server sends a dozen lines
 * of plain text with their block types, not the document, so there is nothing
 * to scale. What survives the trip is the part that does the recognising —
 * where the headings fall, how long the paragraphs run, whether there is a
 * diagram a third of the way down.
 *
 * `aria-hidden` because it is a picture of content that the card already names.
 * A screen reader reading twelve sentence fragments in 8px type would be
 * getting the decoration and missing the label. It also settles the contrast
 * question: nothing here is text to be read, so the ramp can go lighter than
 * body copy is allowed to.
 */
export function PagePreview({ lines }: { lines: PreviewLine[] }) {
  if (!lines.length) {
    return (
      <div className="nt-thumb is-empty" aria-hidden="true">
        <span className="nt-thumb-blank" />
      </div>
    );
  }

  return (
    <div className="nt-thumb" aria-hidden="true">
      {lines.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </div>
  );
}

/**
 * One block. The void kinds — a diagram, an image, a divider — have no words,
 * so they are drawn as the space they occupy, which is exactly what they look
 * like from across the room.
 */
function Line({ line }: { line: PreviewLine }) {
  switch (line.type) {
    case "heading":
      return <p className="nt-thumb-h">{line.text}</p>;

    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem":
    case "toggleListItem":
      return (
        <p className="nt-thumb-li">
          <span className="nt-thumb-marker" />
          {line.text}
        </p>
      );

    case "quote":
      return <p className="nt-thumb-quote">{line.text}</p>;

    case "codeBlock":
    case "mathBlock":
      return <p className="nt-thumb-code">{line.text}</p>;

    case "canvas":
      return <span className="nt-thumb-canvas" />;

    case "table":
      return <span className="nt-thumb-table" />;

    case "divider":
      return <span className="nt-thumb-rule" />;

    case "image":
    case "video":
    case "audio":
    case "file":
      return <span className="nt-thumb-media" />;

    default:
      // A paragraph with nothing in it is a blank line in the document, and a
      // blank line is part of the shape — it keeps the rhythm honest.
      return line.text ? (
        <p className="nt-thumb-p">{line.text}</p>
      ) : (
        <span className="nt-thumb-gap" />
      );
  }
}
