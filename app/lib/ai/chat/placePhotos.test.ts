import { describe, expect, test } from "vitest";
import { namePhotos, photoRefs, redeemPhotos } from "./placePhotos";

const url = (n: number) =>
  `/api/places/photo?ref=${encodeURIComponent(`places/ChIJ${"x".repeat(20)}/photos/AUc7t${"Q".repeat(180)}${n}`)}`;

describe("place photographs by name (NT-98)", () => {
  const found = [
    { name: "Tartine", photos: [url(0), url(1)] },
    { name: "Blue Bottle", photos: [] },
    { name: "Sightglass", photos: [url(2)] },
  ];

  test("each photograph becomes the search's ref and its place in it", () => {
    const { places, urls } = namePhotos(found, "p0123456789");
    expect(places.map((p) => p.photos)).toEqual([["p0123456789.0", "p0123456789.1"], [], ["p0123456789.2"]]);
    expect(places[0].name).toBe("Tartine");
    expect(urls).toEqual([url(0), url(1), url(2)]);
    // What the model is handed is a fraction of what it used to copy.
    expect(JSON.stringify(places).length * 5).toBeLessThan(JSON.stringify(found).length);
  });

  test("a card's names are redeemed for the addresses they stand for", () => {
    const { urls } = namePhotos(found, "p0123456789");
    const html =
      '<nt-location name="Tartine"><note>Good bread.</note>' +
      '<img src="p0123456789.1"><img src="p0123456789.2" off></nt-location>';
    expect(photoRefs(html)).toEqual(["p0123456789"]);
    const out = redeemPhotos(html, { p0123456789: JSON.stringify(urls) });
    expect(out).toEqual({
      html:
        '<nt-location name="Tartine"><note>Good bread.</note>' +
        `<img src="${url(1)}"><img src="${url(2)}" off></nt-location>`,
    });
  });

  test("a name with nothing behind it is reported, not written", () => {
    const { urls } = namePhotos(found, "p0123456789");
    const html = '<img src="p0123456789.7"><img src="pabcdefabcd.0"><img src="p0123456789.0">';
    expect(redeemPhotos(html, { p0123456789: JSON.stringify(urls) })).toEqual({
      missing: ["p0123456789.7", "pabcdefabcd.0"],
    });
  });

  test("a row that is not the proxy's addresses redeems nothing", () => {
    const html = '<img src="p0123456789.0">';
    expect(redeemPhotos(html, { p0123456789: JSON.stringify(["https://evil.example/x.png"]) })).toEqual({
      missing: ["p0123456789.0"],
    });
    expect(redeemPhotos(html, { p0123456789: "<nt-diagram></nt-diagram>" })).toEqual({
      missing: ["p0123456789.0"],
    });
  });

  test("HTML naming no photograph is left exactly as it is", () => {
    const html = `<img src="${url(0)}"><p>p0123456789.0 is not a src</p>`;
    expect(photoRefs(html)).toEqual([]);
    expect(redeemPhotos(html, {})).toEqual({ html });
  });
});
