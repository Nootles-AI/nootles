import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseLocation } from "./parse";
import { serializeLocation } from "./serialize";
import { isMapsUrl, isShortMapsUrl, linkUrl, embedUrl, parseMapsUrl } from "./maps";
import { emptyLocation, shown, showing } from "./types";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseLocation(html, dom);

const CARD =
  '<nt-location name="Blue Bottle Coffee" address="1 Ferry Building, San Francisco, CA"' +
  ' at="37.7955,-122.3937" place="ChIJexample" rating="4.4" votes="1284" off="rating drive">\n' +
  "  <note>Airy, fast wifi, good for mornings.</note>\n" +
  '  <img src="/api/places/photo?ref=places/a/photos/b">\n' +
  '  <img src="https://example.com/mine.jpg" off>\n' +
  "</nt-location>";

describe("the location format", () => {
  it("round-trips byte for byte", () => {
    expect(serializeLocation(parse(CARD))).toBe(CARD);
  });

  it("is idempotent — parsing its own output changes nothing", () => {
    expect(parse(serializeLocation(parse(CARD)))).toEqual(parse(CARD));
  });

  it("reads the whole card", () => {
    const place = parse(CARD);
    expect(place).toMatchObject({
      name: "Blue Bottle Coffee",
      address: "1 Ferry Building, San Francisco, CA",
      at: { lat: 37.7955, lng: -122.3937 },
      place: "ChIJexample",
      rating: 4.4,
      votes: 1284,
      note: "Airy, fast wifi, good for mornings.",
      off: ["rating", "drive"],
    });
    expect(place.images).toHaveLength(2);
    expect(shown(place)).toHaveLength(1);
    expect(showing(place, "rating")).toBe(false);
    expect(showing(place, "drive")).toBe(false);
    // Everything not named is showing — including the drive time, which is on
    // unless somebody says otherwise.
    expect(showing(place, "map")).toBe(true);
    expect(showing(emptyLocation("X"), "drive")).toBe(true);
  });

  it("accepts the tags and attributes a model might reach for instead", () => {
    const loose =
      '<place title="Tartine" lat="37.7614" lng="-122.4241" stars="4.5" reviews="900" hide="photos, map">' +
      "<description>Queue is the point.</description></place>";
    expect(parse(loose)).toMatchObject({
      name: "Tartine",
      at: { lat: 37.7614, lng: -122.4241 },
      rating: 4.5,
      votes: 900,
      note: "Queue is the point.",
      off: ["map", "photos"],
    });
  });

  it("writes the hidden parts in the vocabulary's order, not the clicking order", () => {
    const place = { ...emptyLocation("X"), off: ["photos", "map", "rating"] as never };
    expect(serializeLocation(place)).toContain('off="map rating photos"');
  });

  it("keeps defaults silent", () => {
    const plain = serializeLocation(emptyLocation("Corner shop"));
    expect(plain).toBe('<nt-location name="Corner shop"></nt-location>');
    expect(plain).not.toContain("off=");
  });

  it("escapes a name that would otherwise be markup", () => {
    const nasty = { ...emptyLocation('Ben & Jerry"s <b>'), note: "a < b" };
    const text = serializeLocation(nasty);
    expect(text).toContain('name="Ben &amp; Jerry&quot;s &lt;b&gt;"');
    expect(parse(text).name).toBe('Ben & Jerry"s <b>');
    expect(parse(text).note).toBe("a < b");
  });

  it("refuses a rating that is not out of five", () => {
    expect(parse('<nt-location name="X" rating="9">').rating).toBeUndefined();
    expect(parse('<nt-location name="X" rating="4.2">').rating).toBe(4.2);
  });
});

describe("google maps links", () => {
  it("reads the name and the pin out of a place URL", () => {
    expect(
      parseMapsUrl(
        "https://www.google.com/maps/place/Blue+Bottle+Coffee/@37.7955,-122.3937,17z/data=!3m1",
      ),
    ).toEqual({
      name: "Blue Bottle Coffee",
      at: { lat: 37.7955, lng: -122.3937 },
    });
  });

  it("reads a search URL, a q= URL and a place id", () => {
    expect(parseMapsUrl("https://www.google.com/maps/search/cafes/@37.79,-122.39,15z")).toEqual({
      query: "cafes",
      at: { lat: 37.79, lng: -122.39 },
    });
    expect(parseMapsUrl("https://www.google.com/maps?q=Tartine+Bakery")).toEqual({
      query: "Tartine Bakery",
    });
    expect(
      parseMapsUrl("https://www.google.com/maps/search/?api=1&query=X&query_place_id=ChIJz"),
    ).toMatchObject({ place: "ChIJz" });
  });

  it("reads coordinates written as the query", () => {
    expect(parseMapsUrl("https://maps.google.com/maps?q=37.7955,-122.3937")).toEqual({
      at: { lat: 37.7955, lng: -122.3937 },
    });
  });

  it("knows a short link needs following, and who can follow it", () => {
    expect(isShortMapsUrl("https://maps.app.goo.gl/abc123")).toBe(true);
    expect(isShortMapsUrl("https://www.google.com/maps/place/X/@1,2,17z")).toBe(false);
  });

  it("turns anything else away", () => {
    expect(isMapsUrl("https://example.com/maps")).toBe(false);
    expect(parseMapsUrl("not a url")).toBeNull();
    // A maps URL that named nothing at all is not worth a card.
    expect(parseMapsUrl("https://www.google.com/maps")).toBeNull();
  });

  it("builds the map and the outward link from what the card knows", () => {
    const place = {
      ...emptyLocation("Blue Bottle Coffee"),
      address: "1 Ferry Building",
      at: { lat: 37.7955, lng: -122.3937 },
      place: "ChIJexample",
    };
    expect(embedUrl(place)).toBe(
      "https://maps.google.com/maps?q=Blue%20Bottle%20Coffee%2C%201%20Ferry%20Building&z=16&output=embed",
    );
    expect(linkUrl(place)).toBe(
      "https://www.google.com/maps/search/?api=1&query=Blue%20Bottle%20Coffee%2C%201%20Ferry%20Building&query_place_id=ChIJexample",
    );
    // Nothing but a pin still maps.
    expect(embedUrl({ name: "", at: { lat: 1, lng: 2 } })).toContain("q=1%2C2");
  });
});
