import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";

/**
 * Curates the canvas icon catalog from Iconify's JSON packages.
 *
 * Run `node scripts/build-icons.mjs` after editing the list below; it rewrites
 * the two generated modules under `app/components/editor/canvas/icons/`:
 *
 *  - `names.ts`  — the vocabulary the AI grammar lists, grouped and tiny.
 *  - `catalog.ts` — the path data, lazy-loaded by the icon registry.
 *
 * Everything is converted to bare SVG path data at BUILD time — circles,
 * rects, lines and polygons become path commands here, so the runtime never
 * parses an icon body. An icon whose body holds anything this script cannot
 * convert (masks, defs, clip paths) fails the build by name; pick another.
 *
 * Sources and licenses (all attribution-free):
 *  - `ph:`  Phosphor (MIT) — filled silhouettes, 256-box.
 *  - `ms:`  Material Symbols (Apache-2.0) — filled figures/objects, 24-box.
 *  - `lc:`  Lucide (ISC) — stroke line icons, 24-box.
 *
 * Mode follows the source: ph/ms entries are `fill`, lc entries are `stroke`.
 */

const require = createRequire(import.meta.url);
const SETS = {
  ph: require("@iconify-json/ph/icons.json"),
  ms: require("@iconify-json/material-symbols/icons.json"),
  lc: require("@iconify-json/lucide/icons.json"),
};

/** name → "set:icon-id". Grouped the way the grammar will list them. */
const GROUPS = {
  "people & poses": {
    person: "ms:boy",
    "person-walking": "ms:directions-walk",
    "person-running": "ms:directions-run",
    "person-standing": "lc:person-standing",
    "person-cycling": "ms:directions-bike",
    "person-hiking": "ms:hiking",
    "person-swimming": "ms:pool",
    "person-meditating": "ms:self-improvement",
    "person-dancing": "ms:sports-gymnastics",
    "person-fighting": "ms:sports-martial-arts",
    "person-waving": "ms:waving-hand",
    "person-sitting": "ms:airline-seat-recline-normal",
    "person-wheelchair": "ms:accessible",
    "person-cane": "ms:elderly",
    "person-pregnant": "ms:pregnant-woman",
    "person-skiing": "ms:downhill-skiing",
    "person-snowboarding": "ms:snowboarding",
    "person-skating": "ms:ice-skating",
    "person-surfing": "ms:surfing",
    "person-kayaking": "ms:kayaking",
    "person-rowing": "ms:rowing",
    "person-climbing": "ms:sports-handball",
    "person-kneeling": "ms:sports-kabaddi",
    "person-falling": "ms:falling",
    child: "ms:child-care",
    family: "ms:family-restroom",
    couple: "ms:wc",
    crowd: "ms:groups",
    face: "ph:smiley-fill",
    "face-sad": "ph:smiley-sad-fill",
    "face-angry": "ph:smiley-angry-fill",
    "face-surprised": "ph:smiley-wink-fill",
    eye: "ph:eye-fill",
    "hand-open": "ph:hand-fill",
    "hand-pointing": "ph:hand-pointing-fill",
    "hand-fist": "ph:hand-fist-fill",
    "hands-clapping": "ph:hands-clapping-fill",
    footprints: "ph:footprints-fill",
    skull: "ph:skull-fill",
    baby: "ph:baby-fill",
    "user-outline": "lc:user",
    "users-outline": "lc:users",
  },
  animals: {
    cat: "ph:cat-fill",
    dog: "ph:dog-fill",
    bird: "ph:bird-fill",
    fish: "ph:fish-fill",
    horse: "ph:horse-fill",
    rabbit: "ph:rabbit-fill",
    cow: "ph:cow-fill",
    butterfly: "ph:butterfly-fill",
    "paw-print": "ph:paw-print-fill",
    shrimp: "ph:shrimp-fill",
    "fish-simple": "ph:fish-simple-fill",
    "bird-outline": "lc:bird",
    "cat-outline": "lc:cat",
    "dog-outline": "lc:dog",
    "rat-outline": "lc:rat",
    "turtle-outline": "lc:turtle",
    "squirrel-outline": "lc:squirrel",
    "snail-outline": "lc:snail",
    "worm-outline": "lc:worm",
    bug: "ph:bug-fill",
    ant: "ph:bug-beetle-fill",
    spider: "ms:pest-control",
  },
  "nature & weather": {
    tree: "ph:tree-fill",
    "tree-evergreen": "ph:tree-evergreen-fill",
    "tree-palm": "ph:tree-palm-fill",
    cactus: "ph:cactus-fill",
    flower: "ph:flower-fill",
    "flower-tulip": "ph:flower-tulip-fill",
    "flower-lotus": "ph:flower-lotus-fill",
    plant: "ph:plant-fill",
    leaf: "ph:leaf-fill",
    grains: "ph:grains-fill",
    mountains: "ph:mountains-fill",
    island: "ph:island-fill",
    wave: "ph:waves",
    sun: "ph:sun-fill",
    "sun-horizon": "ph:sun-horizon-fill",
    moon: "ph:moon-fill",
    "moon-stars": "ph:moon-stars-fill",
    star: "ph:star-fill",
    "shooting-star": "ph:shooting-star-fill",
    sparkle: "ph:sparkle-fill",
    cloud: "ph:cloud-fill",
    "cloud-rain": "ph:cloud-rain-fill",
    "cloud-snow": "ph:cloud-snow-fill",
    "cloud-lightning": "ph:cloud-lightning-fill",
    "cloud-sun": "ph:cloud-sun-fill",
    "cloud-moon": "ph:cloud-moon-fill",
    lightning: "ph:lightning-fill",
    rainbow: "ph:rainbow",
    snowflake: "ph:snowflake-fill",
    umbrella: "ph:umbrella-fill",
    wind: "ph:wind",
    tornado: "ph:tornado",
    fire: "ph:fire-fill",
    campfire: "ph:campfire-fill",
    drop: "ph:drop-fill",
    "planet-earth": "ph:globe-hemisphere-west-fill",
    planet: "ph:planet-fill",
    meteor: "ph:meteor-fill",
  },
  "vehicles & travel": {
    car: "ph:car-fill",
    "car-simple": "ph:car-simple-fill",
    "car-side": "ms:directions-car",
    taxi: "ph:taxi-fill",
    "police-car": "ph:police-car-fill",
    ambulance: "ph:ambulance-fill",
    "fire-truck": "ph:fire-truck-fill",
    bus: "ph:bus-fill",
    truck: "ph:truck-fill",
    tractor: "ph:tractor-fill",
    van: "ph:van-fill",
    jeep: "ph:jeep-fill",
    motorcycle: "ph:motorcycle-fill",
    scooter: "ph:scooter-fill",
    bicycle: "ph:bicycle-fill",
    train: "ph:train-fill",
    tram: "ph:tram-fill",
    "train-front": "ms:train",
    subway: "ph:subway-fill",
    airplane: "ph:airplane-fill",
    "airplane-takeoff": "ph:airplane-takeoff-fill",
    "airplane-landing": "ph:airplane-landing-fill",
    helicopter: "ms:no-crash",
    rocket: "ph:rocket-fill",
    "rocket-launch": "ph:rocket-launch-fill",
    boat: "ph:boat-fill",
    sailboat: "ph:sailboat-fill",
    anchor: "ph:anchor-fill",
    "traffic-light": "ph:traffic-signal-fill",
    "traffic-cone": "ph:traffic-cone-fill",
    "road-horizon": "ph:road-horizon-fill",
    signpost: "ph:signpost-fill",
    "map-pin": "ph:map-pin-fill",
    compass: "ph:compass-fill",
    suitcase: "ph:suitcase-fill",
    backpack: "ph:backpack-fill",
    tent: "ph:tent-fill",
    "gas-pump": "ph:gas-pump-fill",
    wheel: "ph:steering-wheel-fill",
  },
  "buildings & places": {
    house: "ph:house-fill",
    "house-line": "ph:house-line-fill",
    buildings: "ph:buildings-fill",
    "building-apartment": "ph:building-apartment-fill",
    "building-office": "ph:building-office-fill",
    castle: "ph:castle-turret-fill",
    church: "ph:church-fill",
    hospital: "ph:hospital-fill",
    factory: "ph:factory-fill",
    warehouse: "ph:warehouse-fill",
    bank: "ph:bank-fill",
    storefront: "ph:storefront-fill",
    barn: "ph:barn-fill",
    lighthouse: "ph:lighthouse-fill",
    windmill: "ph:windmill-fill",
    bridge: "ms:water-damage",
    door: "ph:door-fill",
    "door-open": "ph:door-open-fill",
    window: "ph:app-window-fill",
    stairs: "ph:steps-fill",
    fence: "ms:fence",
    garage: "ph:garage-fill",
    park: "ms:park",
    "ferris-wheel": "ms:attractions",
    tipi: "ph:tipi-fill",
    city: "ms:location-city",
    school: "ms:school",
    stadium: "ms:stadium",
  },
  "objects & household": {
    chair: "ph:chair-fill",
    armchair: "ph:armchair-fill",
    couch: "ph:couch-fill",
    bed: "ph:bed-fill",
    table: "ms:table-restaurant",
    desk: "ph:desk-fill",
    lamp: "ph:lamp-fill",
    "lamp-pendant": "ph:lamp-pendant-fill",
    bathtub: "ph:bathtub-fill",
    toilet: "ph:toilet-fill",
    shower: "ph:shower-fill",
    television: "ph:television-fill",
    radio: "ph:radio-fill",
    "washing-machine": "ph:washing-machine-fill",
    oven: "ph:oven-fill",
    "cooking-pot": "ph:cooking-pot-fill",
    fridge: "ms:kitchen",
    fan: "ph:fan-fill",
    broom: "ph:broom-fill",
    "trash-can": "ph:trash-fill",
    basket: "ph:basket-fill",
    "shopping-cart": "ph:shopping-cart-fill",
    "shopping-bag": "ph:bag-fill",
    gift: "ph:gift-fill",
    package: "ph:package-fill",
    key: "ph:key-fill",
    lock: "ph:lock-fill",
    "lock-open": "ph:lock-open-fill",
    bell: "ph:bell-fill",
    clock: "ph:clock-fill",
    "alarm-clock": "ph:alarm-fill",
    hourglass: "ph:hourglass-fill",
    calendar: "ph:calendar-fill",
    book: "ph:book-fill",
    "book-open": "ph:book-open-fill",
    books: "ph:books-fill",
    newspaper: "ph:newspaper-fill",
    envelope: "ph:envelope-fill",
    "paper-plane": "ph:paper-plane-tilt-fill",
    pencil: "ph:pencil-fill",
    pen: "ph:pen-fill",
    paintbrush: "ph:paint-brush-fill",
    palette: "ph:palette-fill",
    scissors: "ph:scissors-fill",
    paperclip: "ph:paperclip",
    briefcase: "ph:briefcase-fill",
    wallet: "ph:wallet-fill",
    money: "ph:money-fill",
    coins: "ph:coins-fill",
    "piggy-bank": "ph:piggy-bank-fill",
    "credit-card": "ph:credit-card-fill",
    glasses: "ph:eyeglasses-fill",
    sunglasses: "ph:sunglasses-fill",
    "t-shirt": "ph:t-shirt-fill",
    pants: "ph:pants-fill",
    dress: "ph:dress-fill",
    "coat-hanger": "ph:coat-hanger-fill",
    hat: "ph:baseball-cap-fill",
    crown: "ph:crown-fill",
    sneaker: "ph:sneaker-fill",
    "high-heel": "ph:high-heel-fill",
    boot: "ph:boot-fill",
    watch: "ph:watch-fill",
    ring: "ms:circle",
    diamond: "ph:diamond-fill",
    candle: "ms:candle",
    balloon: "ph:balloon-fill",
    kite: "ms:toys",
    "picture-frame": "ph:frame-corners",
    vase: "ms:emoji-nature",
  },
  "food & drink": {
    apple: "ms:nutrition",
    banana: "ph:orange-slice-fill",
    carrot: "ph:carrot-fill",
    pizza: "ph:pizza-fill",
    hamburger: "ph:hamburger-fill",
    "hot-dog": "ms:lunch-dining",
    egg: "ph:egg-fill",
    "ice-cream": "ph:ice-cream-fill",
    popsicle: "ph:popsicle-fill",
    cake: "ph:cake-fill",
    cookie: "ph:cookie-fill",
    bread: "ph:bread-fill",
    coffee: "ph:coffee-fill",
    tea: "ms:emoji-food-beverage",
    "beer-mug": "ph:beer-stein-fill",
    wine: "ph:wine-fill",
    martini: "ph:martini-fill",
    "bottle-water": "ms:water-full",
    "fork-knife": "ph:fork-knife-fill",
    "bowl-food": "ph:bowl-food-fill",
    cherries: "ph:cherries-fill",
    avocado: "ph:avocado-fill",
    pepper: "ph:pepper-fill",
  },
  "tools & work": {
    hammer: "ph:hammer-fill",
    wrench: "ph:wrench-fill",
    screwdriver: "ph:screwdriver-fill",
    shovel: "ph:shovel-fill",
    axe: "ms:carpenter",
    saw: "ms:handyman",
    ladder: "ph:ladder-fill",
    "ladder-simple": "ph:ladder-simple-fill",
    toolbox: "ph:toolbox-fill",
    magnet: "ph:magnet-fill",
    flashlight: "ph:flashlight-fill",
    lightbulb: "ph:lightbulb-fill",
    "lightbulb-on": "ph:lightbulb-filament-fill",
    battery: "ph:battery-full-fill",
    "battery-low": "ph:battery-low-fill",
    plug: "ph:plug-fill",
    gear: "ph:gear-fill",
    gears: "ms:settings-suggest",
    robot: "ph:robot-fill",
    syringe: "ph:syringe-fill",
    pill: "ph:pill-fill",
    stethoscope: "ph:stethoscope-fill",
    "first-aid": "ph:first-aid-kit-fill",
    bandage: "ph:bandaids-fill",
    thermometer: "ph:thermometer-fill",
    microscope: "ph:microscope-fill",
    "test-tube": "ph:test-tube-fill",
    flask: "ph:flask-fill",
    atom: "ph:atom",
    dna: "ph:dna",
    telescope: "ms:home-max-dots",
    binoculars: "ph:binoculars-fill",
    "magnifying-glass": "ph:magnifying-glass-fill",
    scales: "ph:scales-fill",
    gavel: "ph:gavel-fill",
    shield: "ph:shield-fill",
    "shield-check": "ph:shield-check-fill",
    sword: "ph:sword-fill",
    target: "ph:target",
    trophy: "ph:trophy-fill",
    medal: "ph:medal-fill",
    flag: "ph:flag-fill",
    "flag-checkered": "ph:flag-checkered-fill",
    crosshair: "ph:crosshair",
  },
  "tech & media": {
    laptop: "ph:laptop-fill",
    desktop: "ph:desktop-fill",
    monitor: "ph:monitor-fill",
    keyboard: "ph:keyboard-fill",
    mouse: "ph:mouse-fill",
    phone: "ph:device-mobile-fill",
    "phone-call": "ph:phone-call-fill",
    tablet: "ph:device-tablet-fill",
    camera: "ph:camera-fill",
    "video-camera": "ph:video-camera-fill",
    "film-slate": "ph:film-slate-fill",
    "film-reel": "ph:film-reel-fill",
    "film-strip": "ph:film-strip-fill",
    clapperboard: "lc:clapperboard",
    microphone: "ph:microphone-fill",
    headphones: "ph:headphones-fill",
    speaker: "ph:speaker-high-fill",
    "music-note": "ph:music-note-fill",
    "music-notes": "ph:music-notes-fill",
    guitar: "ph:guitar-fill",
    piano: "ph:piano-keys-fill",
    play: "ph:play-fill",
    pause: "ph:pause-fill",
    stop: "ph:stop-fill",
    record: "ph:record-fill",
    "game-controller": "ph:game-controller-fill",
    dice: "ph:dice-five-fill",
    "puzzle-piece": "ph:puzzle-piece-fill",
    wifi: "ph:wifi-high",
    bluetooth: "ph:bluetooth",
    "battery-charging": "ph:battery-charging-fill",
    printer: "ph:printer-fill",
    "floppy-disk": "ph:floppy-disk-fill",
    database: "ph:database-fill",
    "cloud-tech": "lc:cloud",
    server: "lc:server",
    "cpu-chip": "ph:cpu-fill",
    "qr-code": "ph:qr-code",
    barcode: "ph:barcode",
  },
  "symbols & shapes": {
    heart: "ph:heart-fill",
    "heart-broken": "ph:heart-break-fill",
    "heart-outline": "lc:heart",
    "star-outline": "lc:star",
    "check-circle": "ph:check-circle-fill",
    "x-circle": "ph:x-circle-fill",
    "warning-triangle": "ph:warning-fill",
    "question-mark": "ph:question-fill",
    info: "ph:info-fill",
    prohibit: "ph:prohibit",
    recycle: "ph:recycle",
    infinity: "ph:infinity",
    peace: "ph:peace-fill",
    "yin-yang": "ph:yin-yang-fill",
    "smiley-heart": "ph:smiley-melting-fill",
    "thumbs-up": "ph:thumbs-up-fill",
    "thumbs-down": "ph:thumbs-down-fill",
    "chat-bubble": "ph:chat-circle-fill",
    "speech-bubble": "ph:chat-fill",
    "thought-bubble": "ph:chat-circle-dots-fill",
    megaphone: "ph:megaphone-fill",
    "bell-ringing": "ph:bell-ringing-fill",
    "music-speaker": "ph:speaker-hifi-fill",
    "arrow-up-right": "ph:arrow-up-right",
    "arrows-clockwise": "ph:arrows-clockwise",
    "hourglass-half": "ph:hourglass-medium-fill",
    "number-one": "ph:number-circle-one-fill",
    "crown-simple": "ph:crown-simple-fill",
    "ghost": "ph:ghost-fill",
    alien: "ph:alien-fill",
    "magic-wand": "ph:magic-wand-fill",
    bomb: "ms:bomb",
    "detective": "ph:detective-fill",
    "mask-happy": "ph:mask-happy-fill",
    "mask-sad": "ph:mask-sad-fill",
    "crystal-ball": "ms:blur-on",
  },
};

// ---------------------------------------------------------------------------
// SVG primitives → path data
// ---------------------------------------------------------------------------

const num = (el, name, fallback = 0) => {
  const v = Number.parseFloat(el.getAttribute(name) ?? "");
  return Number.isFinite(v) ? v : fallback;
};

function circleToPath(cx, cy, rx, ry) {
  // Two arcs, closed — the standard circle-as-path form.
  return (
    `M ${cx - rx} ${cy} ` +
    `A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
    `A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  );
}

function rectToPath(el) {
  const x = num(el, "x");
  const y = num(el, "y");
  const w = num(el, "width");
  const h = num(el, "height");
  const rx = Math.min(num(el, "rx"), w / 2);
  if (rx <= 0) return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
  const ry = Math.min(num(el, "ry", rx), h / 2);
  return (
    `M ${x + rx} ${y} h ${w - 2 * rx} a ${rx} ${ry} 0 0 1 ${rx} ${ry} ` +
    `v ${h - 2 * ry} a ${rx} ${ry} 0 0 1 ${-rx} ${ry} h ${-(w - 2 * rx)} ` +
    `a ${rx} ${ry} 0 0 1 ${-rx} ${-ry} v ${-(h - 2 * ry)} ` +
    `a ${rx} ${ry} 0 0 1 ${rx} ${-ry} Z`
  );
}

function pointsToPath(el, close) {
  const nums = (el.getAttribute("points") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const parts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    parts.push(`${i === 0 ? "M" : "L"} ${nums[i]} ${nums[i + 1]}`);
  }
  return parts.join(" ") + (close ? " Z" : "");
}

function elementToD(el) {
  switch (el.tagName.toLowerCase()) {
    case "path":
      return el.getAttribute("d") ?? "";
    case "circle": {
      const r = num(el, "r");
      return circleToPath(num(el, "cx"), num(el, "cy"), r, r);
    }
    case "ellipse":
      return circleToPath(num(el, "cx"), num(el, "cy"), num(el, "rx"), num(el, "ry"));
    case "rect":
      return rectToPath(el);
    case "line":
      return `M ${num(el, "x1")} ${num(el, "y1")} L ${num(el, "x2")} ${num(el, "y2")}`;
    case "polyline":
      return pointsToPath(el, false);
    case "polygon":
      return pointsToPath(el, true);
    default:
      return null;
  }
}

function bodyToD(body, id) {
  const { document } = parseHTML(`<svg>${body}</svg>`);
  const parts = [];
  const walk = (el) => {
    for (const child of el.children) {
      if (child.tagName.toLowerCase() === "g") {
        walk(child);
        continue;
      }
      const d = elementToD(child);
      if (d === null) {
        throw new Error(`${id}: unconvertible <${child.tagName.toLowerCase()}>`);
      }
      if (d) parts.push(d.trim());
    }
  };
  walk(document.querySelector("svg"));
  if (!parts.length) throw new Error(`${id}: empty body`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const catalog = {};
const groups = [];
const failures = [];

for (const [group, entries] of Object.entries(GROUPS)) {
  const fill = [];
  const stroke = [];
  for (const [name, ref] of Object.entries(entries)) {
    const [prefix, id] = ref.split(":");
    const set = SETS[prefix];
    const icon = set?.icons[id];
    if (!icon) {
      failures.push(`${name} → ${ref} (no such icon)`);
      continue;
    }
    const mode = prefix === "lc" ? "stroke" : "fill";
    const w = icon.width ?? set.width ?? 24;
    const h = icon.height ?? set.height ?? 24;
    try {
      const d = bodyToD(icon.body, ref);
      if (catalog[name]) {
        failures.push(`${name} (duplicate name)`);
        continue;
      }
      catalog[name] = { w, h, mode, d };
      (mode === "fill" ? fill : stroke).push(name);
    } catch (error) {
      failures.push(String(error.message ?? error));
    }
  }
  groups.push({ group, fill, stroke });
}

if (failures.length) {
  console.error(`FAILED — ${failures.length} entries:\n  ` + failures.join("\n  "));
  process.exit(1);
}

const dir = new URL("../app/components/editor/canvas/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });

const banner = `// Generated by scripts/build-icons.mjs — do not edit by hand.
// Sources: Phosphor (MIT), Material Symbols (Apache-2.0), Lucide (ISC).`;

writeFileSync(
  new URL("names.ts", dir),
  `${banner}

/** The icon vocabulary, grouped for the grammar. Names only — the geometry
 * lives in catalog.ts, which stays out of every bundle until an AI lane arms. */
export const ICON_GROUPS: readonly {
  group: string;
  fill: readonly string[];
  stroke: readonly string[];
}[] = ${JSON.stringify(groups, null, 2)};
`,
);

writeFileSync(
  new URL("catalog.ts", dir),
  `${banner}

import type { IconDef } from "./registry";

export const ICON_CATALOG: Record<string, IconDef> = ${JSON.stringify(catalog)};
`,
);

const bytes = JSON.stringify(catalog).length;
console.log(
  `wrote ${Object.keys(catalog).length} icons in ${groups.length} groups ` +
    `(catalog ${(bytes / 1024).toFixed(0)}KB)`,
);
