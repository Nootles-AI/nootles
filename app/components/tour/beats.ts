/**
 * The gated beats, in the order they are taught.
 *
 * Orientation comes first: before any editing lesson can land, the user has to
 * know where they are — inside a project, whose pages the sidebar lists,
 * reached from a home screen that lists every project. Teaching editor moves
 * to someone who does not yet know what they are looking at was the old
 * guide's mistake. The slash menu follows because it is the answer to "how do
 * I do anything here". The canvas closes the guide and carries two lessons in
 * one beat: watching a diagram get drawn, then finding out it is a real
 * editor rather than a picture.
 *
 * A module of its own so the Projects screen — which ticks the tail's
 * "projects" item — can read GATED without pulling the tour's editor plumbing
 * into its bundle.
 */
export const ORIENT = 0;
export const SLASH = 1;
export const WRITE = 2;
export const CHAT = 3;
export const CANVAS = 4;
export const GATED = 5;
