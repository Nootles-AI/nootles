import { describe, expect, it } from "vitest";
import { blockTypeFor, classify, describeSource } from "./link";

describe("media link classification", () => {
  it("turns a Spotify track page into the compact player", () => {
    const source = classify(
      "https://open.spotify.com/track/1oHNvJVbFkexQc0BpQp7Y4?si=abc123",
    );
    expect(source).toEqual({
      kind: "spotify",
      embedUrl: "https://open.spotify.com/embed/track/1oHNvJVbFkexQc0BpQp7Y4",
      height: 152,
    });
  });

  it("reads the intl-prefixed and embed spellings of a Spotify URL", () => {
    for (const raw of [
      "https://open.spotify.com/intl-de/track/1oHNvJVbFkexQc0BpQp7Y4",
      "https://open.spotify.com/embed/track/1oHNvJVbFkexQc0BpQp7Y4",
    ]) {
      expect(classify(raw)?.kind).toBe("spotify");
    }
  });

  it("gives a Spotify collection the tall player", () => {
    const source = classify("https://open.spotify.com/album/4SZko61aMnmgvNhfhgTuD3");
    expect(source).toMatchObject({ kind: "spotify", height: 352 });
  });

  it("reads a Spotify search as the search it is, not as a player", () => {
    expect(classify("https://open.spotify.com/search/after%20the%20storm")).toEqual({
      kind: "search",
      url: "https://open.spotify.com/search/after%20the%20storm",
      provider: "Spotify",
      query: "after the storm",
    });
  });

  it("names a search on the other shelves too", () => {
    expect(classify("https://www.youtube.com/results?search_query=powers+of+ten")).toMatchObject({
      kind: "search",
      provider: "YouTube",
      query: "powers of ten",
    });
    expect(classify("https://music.apple.com/us/search?term=kali%20uchis")).toMatchObject({
      kind: "search",
      provider: "Apple Music",
      query: "kali uchis",
    });
    expect(classify("https://soundcloud.com/search?q=flickermood")).toMatchObject({
      kind: "search",
      provider: "SoundCloud",
      query: "flickermood",
    });
  });

  it("refuses an id that is not shaped like one — a wrong id is a 404 in a frame", () => {
    // 21 chars and 23 chars: a Spotify id is exactly 22.
    expect(classify("https://open.spotify.com/track/5mCPDVBb16L4XQwDdbRUp")?.kind).toBe("link");
    expect(classify("https://open.spotify.com/track/5mCPDVBb16L4XQwDdbRUpzZ")?.kind).toBe("link");
    // A YouTube video id is exactly 11.
    expect(classify("https://www.youtube.com/watch?v=dQw4w9Wg")?.kind).toBe("link");
    expect(classify("https://youtu.be/dQw4w9WgXcQXX")?.kind).toBe("link");
  });

  it("takes the URI the Spotify app copies, which names a track exactly", () => {
    expect(classify("spotify:track:5mCPDVBb16L4XQwDdbRUpz")).toEqual({
      kind: "spotify",
      embedUrl: "https://open.spotify.com/embed/track/5mCPDVBb16L4XQwDdbRUpz",
      height: 152,
    });
    expect(classify("spotify:album:4SZko61aMnmgvNhfhgTuD3")).toMatchObject({ height: 352 });
    // Still nothing that is not an id.
    expect(classify("spotify:track:../../evil")).toBeNull();
  });

  it("moves an Apple Music album to the embed host, song selection intact", () => {
    const source = classify(
      "https://music.apple.com/us/album/isolation/1361511857?i=1361512115",
    );
    expect(source).toEqual({
      kind: "apple",
      embedUrl:
        "https://embed.music.apple.com/us/album/isolation/1361511857?i=1361512115",
      height: 175,
    });
    expect(
      classify("https://music.apple.com/us/album/isolation/1361511857"),
    ).toMatchObject({ height: 450 });
  });

  it("embeds every spelling of a YouTube video via the nocookie host", () => {
    for (const raw of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    ]) {
      expect(classify(raw)).toEqual({
        kind: "youtube",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      });
    }
  });

  it("embeds a YouTube playlist as a series", () => {
    expect(
      classify("https://www.youtube.com/playlist?list=PL0123456789abcdef"),
    ).toEqual({
      kind: "youtube",
      embedUrl:
        "https://www.youtube-nocookie.com/embed/videoseries?list=PL0123456789abcdef",
    });
  });

  it("embeds every spelling of a Vimeo video via its player", () => {
    for (const raw of [
      "https://vimeo.com/76979871",
      "https://vimeo.com/channels/staffpicks/76979871",
      "https://vimeo.com/groups/name/videos/76979871",
      "https://player.vimeo.com/video/76979871",
    ]) {
      expect(classify(raw)).toEqual({
        kind: "vimeo",
        embedUrl: "https://player.vimeo.com/video/76979871",
      });
    }
  });

  it("keeps an unlisted Vimeo hash, which the player needs back", () => {
    expect(classify("https://vimeo.com/76979871/abcd1234ef")).toEqual({
      kind: "vimeo",
      embedUrl: "https://player.vimeo.com/video/76979871?h=abcd1234ef",
    });
  });

  it("recognises an Uppbeat track and names it — no embed exists", () => {
    expect(
      classify("https://uppbeat.io/t/kevin-macleod/monkeys-spinning-monkeys"),
    ).toEqual({
      kind: "uppbeat",
      url: "https://uppbeat.io/t/kevin-macleod/monkeys-spinning-monkeys",
      label: "monkeys spinning monkeys — kevin macleod",
    });
    expect(classify("https://uppbeat.io/browse/music")?.kind).toBe("link");
  });

  it("hands any named SoundCloud page to the resolving widget", () => {
    const source = classify("https://soundcloud.com/forss/flickermood");
    expect(source).toEqual({
      kind: "soundcloud",
      embedUrl:
        "https://w.soundcloud.com/player/?url=" +
        encodeURIComponent("https://soundcloud.com/forss/flickermood"),
      height: 166,
    });
    expect(classify("https://soundcloud.com/")?.kind).toBe("link");
  });

  it("plays a file: by extension, or anything out of Convex storage", () => {
    expect(classify("https://example.com/song.mp3")).toMatchObject({
      kind: "file",
      media: "audio",
    });
    expect(classify("https://example.com/song.FLAC")).toMatchObject({
      media: "audio",
    });
    expect(classify("https://example.com/clip.mp4")).toMatchObject({
      kind: "file",
      media: "video",
    });
    // Storage serves no extension: the block that uploaded it knows which.
    expect(
      classify("https://happy-otter-123.convex.cloud/api/storage/abc-def"),
    ).toMatchObject({ kind: "file", media: null });
  });

  it("settles which block a link belongs in", () => {
    expect(blockTypeFor("https://open.spotify.com/track/1oHNvJVbFkexQc0BpQp7Y4")).toBe("audio");
    expect(blockTypeFor("https://uppbeat.io/t/a/b")).toBe("audio");
    expect(blockTypeFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("video");
    expect(blockTypeFor("https://vimeo.com/76979871")).toBe("video");
    expect(blockTypeFor("https://example.com/clip.webm")).toBe("video");
    // Says nothing about itself: the block stays what it already is.
    expect(blockTypeFor("https://x.convex.cloud/api/storage/abc")).toBeNull();
    expect(blockTypeFor("https://bandcamp.com/some-song")).toBeNull();
    expect(blockTypeFor("nonsense")).toBeNull();
  });

  it("keeps an unrecognised web URL as a link", () => {
    expect(classify("https://bandcamp.com/some-song")?.kind).toBe("link");
  });

  it("refuses what is not a web URL at all", () => {
    expect(classify("after the storm")).toBeNull();
    expect(classify("")).toBeNull();
    // A src that could smuggle script must never reach an iframe or an anchor.
    expect(classify("javascript:alert(1)")).toBeNull();
    expect(classify("data:text/html,<script>1</script>")).toBeNull();
  });

  it("says where a block plays from, in the projection's word", () => {
    expect(describeSource("https://open.spotify.com/track/1oHNvJVbFkexQc0BpQp7Y4")).toBe(
      "spotify",
    );
    expect(describeSource("https://music.apple.com/us/album/x/1?i=2")).toBe(
      "apple music",
    );
    expect(describeSource("https://example.com/song.mp3")).toBe("file");
    expect(describeSource("https://vimeo.com/76979871")).toBe("vimeo");
    expect(describeSource("https://uppbeat.io/t/a/b")).toBe("uppbeat");
    expect(describeSource("nonsense")).toBeNull();
  });
});
