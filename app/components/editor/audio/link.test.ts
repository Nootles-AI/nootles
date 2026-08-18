import { describe, expect, it } from "vitest";
import { classify, describeSource } from "./link";

describe("audio link classification", () => {
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

  it("keeps a Spotify search as a link — no id to guess at", () => {
    expect(classify("https://open.spotify.com/search/after%20the%20storm")).toEqual({
      kind: "link",
      url: "https://open.spotify.com/search/after%20the%20storm",
    });
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
    expect(classify("https://example.com/song.mp3")?.kind).toBe("file");
    expect(classify("https://example.com/song.FLAC")?.kind).toBe("file");
    expect(
      classify("https://happy-otter-123.convex.cloud/api/storage/abc-def")?.kind,
    ).toBe("file");
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
    expect(describeSource("nonsense")).toBeNull();
  });
});
