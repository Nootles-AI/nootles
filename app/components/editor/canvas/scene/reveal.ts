/** The ids of every shape in a serialized scene — never the root's, never an edge's. */
export function shapeIdsIn(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/<nt-(?!diagram\b|edge\b)[a-z]+\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]),
  );
}
