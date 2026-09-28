import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { serializeLocation } from "@/app/components/editor/location/serialize";
import { album, check, h2, location, p, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A team offsite: why it is happening, where (three candidate places, each a
 * card with its map), the agenda, the logistics, and an album for the photos
 * afterwards.
 *
 * The candidates are regions rather than venues, so the example stays true —
 * a named hotel changes hands, prices and phone numbers; a coastline does not.
 * Drive time is off for the reason it is off on the itinerary: it answers
 * from wherever the reader is sitting, which is not where the team leaves from.
 */
const area = (name: string, address: string, lat: number, lng: number, note: string) =>
  location(
    serializeLocation({ name, address, at: { lat, lng }, note, images: [], off: ["drive"] }),
  );

export const offsite: ProjectTemplate = {
  id: "offsite",
  name: "Team offsite",
  description: "Goals, candidate places with maps, the agenda, logistics and photos",
  rows: [
    {
      kind: "page",
      title: "Plan",
      blocks: [
        p("Why the team is getting together, and what should be different when it gets back."),
        h2("Goals"),
        check("The one decision we need to leave with"),
        check("Time together that is not a meeting"),
        h2("The basics"),
        table(
          ["", "Details"],
          ["Dates", ""],
          ["People", ""],
          ["Budget", ""],
          ["Organiser", ""],
        ),
        h2("Budget"),
        table(
          ["", "Planned", "Spent"],
          ["Travel", "", ""],
          ["Rooms", "", ""],
          ["Food", "", ""],
          ["Activities", "", ""],
        ),
      ],
    },
    {
      kind: "page",
      title: "Where",
      blocks: [
        p(
          "Three candidates, as an example to write over. Type / and choose Location to add a place, then compare them in the table.",
        ),
        area(
          "Sonoma",
          "California",
          38.2919,
          -122.458,
          "Vineyards and a walkable town square. Easy to reach, hard to stay focused.",
        ),
        area(
          "Half Moon Bay",
          "California",
          37.4636,
          -122.4286,
          "On the coast and close to the airport. Cold in summer.",
        ),
        area(
          "South Lake Tahoe",
          "California",
          38.9399,
          -119.9772,
          "The furthest, and the most like getting away.",
        ),
        h2("Compared"),
        table(
          ["", "Getting there", "Rooms", "Cost per head", "Vote"],
          ["Sonoma", "", "", "", ""],
          ["Half Moon Bay", "", "", "", ""],
          ["South Lake Tahoe", "", "", "", ""],
        ),
      ],
    },
    {
      kind: "page",
      title: "Agenda",
      blocks: [
        p("Mornings for the work, afternoons for everything else."),
        h2("Day one"),
        table(
          ["Time", "What", "Who leads"],
          ["10:00", "Arrive, coffee", ""],
          ["11:00", "Where we are: the last six months", ""],
          ["13:00", "Lunch", ""],
          ["15:00", "Out of the building", ""],
          ["19:00", "Dinner", ""],
        ),
        h2("Day two"),
        table(
          ["Time", "What", "Who leads"],
          ["09:30", "The decision", ""],
          ["12:00", "What we are committing to", ""],
          ["13:00", "Lunch, then home", ""],
        ),
      ],
    },
    {
      kind: "page",
      title: "Logistics",
      blocks: [
        check("Dates held in everyone’s calendar"),
        check("Place booked"),
        check("Travel booked"),
        check("Dietary needs collected"),
        check("Agenda shared a week ahead"),
        h2("Who is travelling how"),
        table(["Name", "Arriving", "Leaving", "Room"], ["", "", "", ""]),
      ],
    },
    {
      kind: "page",
      title: "Photos",
      blocks: [
        p("Afterwards: everyone drops their photos here."),
        album(serializeAlbum({ items: [] })),
      ],
    },
  ],
};
