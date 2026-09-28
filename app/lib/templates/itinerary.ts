import { serializeLocation } from "@/app/components/editor/location/serialize";
import type { Location } from "@/app/components/editor/location/types";
import { check, h2, location, p, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A trip, filled in: three days in Lisbon, every stop a place card with its
 * map. Unlike the document templates this one is an example rather than a
 * scaffold, because a map card with no place on it is a search box — the point
 * of the template is lost until a place is in it.
 *
 * Cards are written through the card's own serializer, so each is in the
 * canonical form the block reads. Drive time is off on every one: it is a
 * question about where the reader is standing, which on a plan made at home
 * is the wrong place, and answering it asks for their location.
 */
const place = (
  name: string,
  address: string,
  lat: number,
  lng: number,
  note: string,
) =>
  location(
    serializeLocation({
      name,
      address,
      at: { lat, lng },
      note,
      images: [],
      off: ["drive"],
    } satisfies Location),
  );

export const itinerary: ProjectTemplate = {
  id: "itinerary",
  name: "Itinerary",
  description: "A trip laid out day by day, every stop a place with its map",
  rows: [
    {
      kind: "page",
      title: "Trip",
      blocks: [
        p(
          "Three days in Lisbon, as an example to write over. Every stop is a place card: type / and choose Location, then search for a place or paste a Google Maps link.",
        ),
        h2("Bookings"),
        table(
          ["What", "When", "Reference", "Cost"],
          ["Flight out", "Fri 08:40", "", ""],
          ["Hotel, 3 nights", "Fri – Mon", "", ""],
          ["Sintra train", "Sun 09:11", "", ""],
          ["Flight home", "Mon 18:05", "", ""],
        ),
        h2("Where we are staying"),
        place(
          "Baixa-Chiado",
          "Lisbon, Portugal",
          38.7106,
          -9.1415,
          "Central enough to walk to most of Days 1 and 2.",
        ),
        h2("Budget"),
        table(
          ["", "Planned", "Spent"],
          ["Travel", "", ""],
          ["Stay", "", ""],
          ["Food", "", ""],
          ["Tickets", "", ""],
        ),
      ],
    },
    {
      kind: "folder",
      title: "Days",
      pages: [
        {
          title: "Friday — Alfama",
          blocks: [
            p("Land, drop the bags, and spend the afternoon on the old town's hill."),
            h2("Afternoon"),
            place(
              "Castelo de São Jorge",
              "R. de Santa Cruz do Castelo, Lisbon",
              38.7139,
              -9.1335,
              "Go late in the day, when the light is on the river.",
            ),
            place(
              "Miradouro de Santa Luzia",
              "Largo Santa Luzia, Lisbon",
              38.7118,
              -9.1301,
              "On the way down from the castle.",
            ),
            h2("Evening"),
            p("Dinner in Alfama. Walk, don't taxi — the lanes are the point."),
          ],
        },
        {
          title: "Saturday — Belém",
          blocks: [
            p("The river side of the city: take the 15E tram west from Praça da Figueira."),
            h2("Morning"),
            place(
              "Mosteiro dos Jerónimos",
              "Praça do Império, Lisbon",
              38.6979,
              -9.2068,
              "Tickets online; the cloister is the part worth the queue.",
            ),
            place(
              "Pastéis de Belém",
              "R. de Belém 84, Lisbon",
              38.6975,
              -9.2033,
              "Eat them warm, at the counter inside.",
            ),
            h2("Afternoon"),
            place(
              "Torre de Belém",
              "Av. Brasília, Lisbon",
              38.6916,
              -9.216,
              "Better from the outside than the inside.",
            ),
            place(
              "LX Factory",
              "R. Rodrigues de Faria 103, Lisbon",
              38.7035,
              -9.1784,
              "On the way back into town. Bookshops, lunch, drinks.",
            ),
          ],
        },
        {
          title: "Sunday — Sintra",
          blocks: [
            p("A day out: forty minutes on the train from Rossio."),
            place(
              "Palácio Nacional da Pena",
              "Estrada da Pena, Sintra",
              38.7876,
              -9.3906,
              "Book a timed entry the day before.",
            ),
            place(
              "Quinta da Regaleira",
              "R. Barbosa du Bocage 5, Sintra",
              38.7963,
              -9.396,
              "The initiation well is the one to see.",
            ),
            h2("Getting back"),
            p("Trains back to Rossio run until late; no need to book."),
          ],
        },
      ],
    },
    {
      kind: "page",
      title: "Packing",
      blocks: [
        p("Tick as it goes in the bag."),
        check("Passport"),
        check("Chargers and an adapter"),
        check("Shoes for hills and cobbles"),
        check("A layer for the evening wind"),
      ],
    },
  ],
};
