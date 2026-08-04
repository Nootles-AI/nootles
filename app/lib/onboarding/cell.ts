/**
 * One table cell, in the shape the page renderer reads.
 *
 * A cell's text is inline content, not a string, so writing these by hand in
 * every template would bury four words of copy in twenty of structure. Only
 * ever used by the welcome preview's showcase blocks.
 */
export function cell(text: string) {
  return [{ type: "text", text, styles: {} }];
}
