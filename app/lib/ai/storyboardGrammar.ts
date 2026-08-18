/**
 * The storyboard grammar, taught once — the canvas grammar's companion.
 *
 * Its own module for the reason `canvasGrammar.ts` is: more than one lane will
 * want it (the chat agent today, a builder tomorrow), and a grammar copied into
 * a prompt is a grammar that drifts from the parser the first time either is
 * touched.
 *
 * It is deliberately short, and it is short because the container model made it
 * so. An earlier design built a board out of one canvas, and teaching it took
 * three times this: frame-local coordinates, which groups were scaffolding and
 * must not be edited, how auto-layout decides what carries x/y. Giving each
 * shot its own canvas deleted all of that from the prompt as well as from the
 * code — a shot is a diagram at its own origin, which the model already knows
 * how to write.
 */
export const STORYBOARD_GRAMMAR = `A storyboard is a list of shots. Each shot is a small
canvas with a note under it, and the shots are laid out in as many columns as the page
has room for — so the board reflows on its own and you never place a shot yourself.

  <nt-storyboard ratio="16:9">
    <nt-shot>
      <nt-diagram w="320" h="180">…the picture, drawn…</nt-diagram>
      <nt-note>What happens in this shot.</nt-note>
    </nt-shot>
    <nt-shot>
      <nt-diagram w="320" h="180">…</nt-diagram>
      <nt-note>And in this one.</nt-note>
    </nt-shot>
  </nt-storyboard>

THE PICTURE is an ordinary <nt-diagram>, drawn exactly as THE CANVAS says — every shape,
the pen, and the same rules about what to draw with. Its own top-left is 0 0; a shot knows
nothing about the board around it or the shots beside it. It is 320 wide, and as tall as
the ratio makes it: 16:9 → 180, 2.39:1 → 134, 1.85:1 → 173, 4:3 → 240, 1:1 → 320,
9:16 → 569 (portrait — reels, shorts). Give
every shot the same w and h as the board's ratio. A shot with nothing drawn yet has no
<nt-diagram> at all.

Draw for the size. A shot is shown a couple of hundred pixels wide, so it wants a few bold
shapes and no fine detail — a figure, a horizon, a doorway. It is a shot, not a schematic.

WRITE FIRST, THEN DRAW. A storyboard is a story before it is pictures, and the notes are
the script the pictures answer to. Build a board in that order, as two edits:
 1. Write the whole board and COMMIT it with edit_page — every shot's note filled, no
    <nt-diagram> yet. The user reads the story while the drawing happens.
 2. Then one draw call per shot, all in one step, each brief built FROM that shot's note —
    the note's action is the subject; add composition, light and the board's shared style
    words. Place them with a second edit_page, notes unchanged, each shot carrying the ref
    its own draw call returned:
      <nt-shot><nt-diagram ref="d4a91c"></nt-diagram><nt-note>The note, as written</nt-note></nt-shot>
Never draw a shot whose note you have not written: a picture that came first leaves the
note describing the drawing instead of the story.

THE NOTE is the action, in plain words on ruled lines. Text only: no tags, no marks, no
page references. Line breaks are real newlines. Two or three short lines is what fits.

SHOT NUMBERS draw themselves from position. Never write a number in a note.

RATIO is the board's, not the shot's. Changing it re-crops every shot — the drawings keep
their coordinates and the frame around them changes, which is what changing format does.
A w or cols attribute on <nt-storyboard> is display state the user set — the width they
dragged the board to, the column count they pinned. Keep both exactly as you found them,
and never add one.

TO EDIT a board, return the WHOLE <nt-storyboard> element with every shot in it, changing
only what you mean to change. Shots have no ids: they are addressed by position, so a
board that comes back with five shots where there were six has deleted the sixth. Adding,
removing and reordering shots is done by writing the list you want.

A shot already drawn reads back as a stub — <nt-diagram drawn="Close on the thief —
240 shapes" at="…"></nt-diagram> — because the picture itself is too big to be worth
showing you. The drawn attribute names what the picture shows. The stub IS that
picture: return it exactly as it came, attributes and all, to keep the picture; move it
to another shot to move the picture; leave it out to delete it; put a fresh draw ref in
its place to redraw that shot. Never write shapes into a stub, and never invent one. To
hand-edit a drawn picture's shapes, read the page again with expand: [the board's block
id] and edit the shapes it shows you.

EVERY SHOT IS THE ARTIST'S — kind stays "scene" for all of them. A title card or an end
card is drawn lettering, part of the picture; never send a shot down kind:"diagram",
whose diagrams do not belong on a board.

A DRAW THAT FAILS is retried, not replaced: call draw again with the SAME brief —
finished work is kept, so a retry is free and answers instantly once the drawing lands.
After a second miss, say which shots stayed written-only; never quietly leave a board
part-drawn.

FILLING OR REDRAWING shots on a board drawn earlier: build each brief FROM that shot's
note, and reuse the exact style words the board's other briefs used — your earlier draw
calls show them, and each stub's drawn attribute says what its picture shows. The fills
must read as frames of the same film, drawn by the same hand.`;
