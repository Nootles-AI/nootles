/**
 * The two questions the Context Sheet always has room for.
 *
 * They are the ones the new-project dialog asks, so the answers typed before a
 * project existed and the answers edited afterwards are the same two rows —
 * without a shared name for them, editing "Description" later would quietly add
 * a third entry saying the same thing in different words.
 *
 * No imports, deliberately: this module is read by Convex functions and by the
 * browser, and anything server-only in here would be bundled into the client.
 */
export const ABOUT = "What is this project?";
export const BACKGROUND = "What should be known before working on it?";
