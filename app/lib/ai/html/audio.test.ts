import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseDocHtml } from "./parse";
import { toDocHtml } from "./serialize";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseDocHtml(html, dom);

/**
 * The audio element is how the AI puts a song on a page — "add a drake song
 * below" ends as one of these. What has to hold: the element a model writes
 * lands on the block's props, the spellings a model might reach for are
 * accepted, and a block serializes back to the same element it parses from.
 */
describe("audio in the document grammar", () => {
  it("parses a model-written song into an insert of the audio block", () => {
    expect(
      parse(
        '<audio src="https://open.spotify.com/track/1oHNvJVbFkexQc0BpQp7Y4" title="After the Storm — Kali Uchis"></audio>',
      ),
    ).toEqual([
      {
        type: "audio",
        id: undefined,
        url: "https://open.spotify.com/track/1oHNvJVbFkexQc0BpQp7Y4",
        caption: "After the Storm — Kali Uchis",
      },
    ]);
  });

  it("accepts the tags a model might reach for instead", () => {
    for (const tag of ["song", "music", "nt-audio"]) {
      const nodes = parse(`<${tag} src="https://example.com/a.mp3"></${tag}>`);
      expect(nodes[0]).toMatchObject({ type: "audio", url: "https://example.com/a.mp3" });
    }
  });

  it("round-trips a stored block through the grammar", () => {
    const block = {
      id: "b1",
      type: "audio",
      props: {
        url: "https://soundcloud.com/forss/flickermood",
        name: "",
        caption: "Flickermood — Forss",
      },
    };
    const html = toDocHtml([block]);
    expect(html).toBe(
      '<audio id="b1" src="https://soundcloud.com/forss/flickermood" title="Flickermood — Forss"></audio>',
    );
    expect(parse(html)).toEqual([
      {
        type: "audio",
        id: "b1",
        url: "https://soundcloud.com/forss/flickermood",
        caption: "Flickermood — Forss",
      },
    ]);
  });

  it("keeps a source the model omitted, rather than blanking it", () => {
    expect(parse('<audio id="b1" title="renamed"></audio>')).toEqual([
      { type: "audio", id: "b1", url: undefined, caption: "renamed" },
    ]);
  });
});
