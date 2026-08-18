import { PARTS, type Location } from "./types";

/**
 * {@link Location} → location HTML, in exactly one form.
 *
 * The canonical form is what the parser normalises to, which is what makes
 * `serializeLocation(parseLocation(html)) === html` a fact rather than a hope:
 * canonical tags only, one child per line, two-space indent, and a fixed
 * attribute order — `id`, `name`, `address`, `at`, `place`, `rating`, `votes`
 * and `off` on the root; `src` then `off` on a picture.
 *
 * Defaults are silence: a card nobody has edited writes no `off`, and a place
 * we were never told the rating of writes neither `rating` nor `votes`. Drive
 * time is a part like any other now — shown unless it is in `off`.
 */

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

function attr(name: string, value: string): string {
  return ` ${name}="${esc(value)}"`;
}

/** Six places is a metre or so — past that the digits are noise, not accuracy. */
function coord(value: number): string {
  return String(Number(value.toFixed(6)));
}

export function serializeLocation(location: Location): string {
  const id = location.id ? attr("id", location.id) : "";
  const address = location.address ? attr("address", location.address) : "";
  const at = location.at
    ? attr("at", `${coord(location.at.lat)},${coord(location.at.lng)}`)
    : "";
  const place = location.place ? attr("place", location.place) : "";
  const rating =
    location.rating !== undefined ? attr("rating", String(location.rating)) : "";
  const votes = location.votes !== undefined ? attr("votes", String(location.votes)) : "";
  // Written in the vocabulary's own order rather than the order they were
  // clicked, so two cards hiding the same things are the same text.
  const hidden = PARTS.filter((part) => location.off.includes(part));
  const off = hidden.length ? attr("off", hidden.join(" ")) : "";

  const children = [
    ...(location.note ? [`  <note>${esc(location.note)}</note>`] : []),
    ...location.images.map(
      (image) => `  <img${attr("src", image.src)}${image.off ? " off" : ""}>`,
    ),
  ].join("\n");

  return `<nt-location${id}${attr("name", location.name)}${address}${at}${place}${rating}${votes}${off}>${
    children ? `\n${children}\n` : ""
  }</nt-location>`;
}
