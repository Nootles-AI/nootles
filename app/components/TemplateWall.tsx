import type { ReactNode } from "react";

/**
 * What a Nootles page can hold, as a wall of pages: code, a flowchart, a table,
 * maths, a mockup, an album, a map, a storyboard — laid like brick, three
 * courses wide, square to the pane and running off its edges so it reads as a
 * piece of something larger.
 *
 * Drawn, not rendered. The thumbnail renderer lays a page out at 600px and
 * shrinks it; at a tile's width that is 4px type, and it has no picture of a
 * map or an album to shrink in the first place. These are illustrations of
 * pages, art-directed for the size they are seen at. A single template's
 * preview, where fidelity is the point, uses the real renderer.
 *
 * Decorative, and marked so: the row it sits beside says what it is.
 */

const W = 150;
/** Pages are drawn at `W` and shown smaller, so the gaps between them carry
 *  more of the wall. */
const SHOWN = 0.86;
const INK = "var(--foreground)";
const SOFT = "oklch(0.9 0.003 90)";
const RULE = "oklch(0.8 0.004 90)";
const FILL = "#eef1f7";
const FILL_EDGE = "#cdd5e5";
const MINT = "#e9f2ef";
const MINT_EDGE = "#c6dad3";

function Page({ h, title, children }: { h: number; title: number; children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${h}`} width={W * SHOWN} height={h * SHOWN} className="nt-wall-tile">
      <rect width={W} height={h} fill="var(--background)" />
      <rect x={12} y={13} width={title} height={5} rx={1.5} fill={INK} />
      {children}
    </svg>
  );
}

/** Lines of prose, as the grey bars a page is at this distance. */
function Prose({ y, widths, x = 12 }: { y: number; widths: number[]; x?: number }) {
  return (
    <>
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * 7} width={w} height={2.5} rx={1.25} fill={SOFT} />
      ))}
    </>
  );
}

const Sub = ({ y, w }: { y: number; w: number }) => (
  <rect x={12} y={y} width={w} height={3.5} rx={1.25} fill={INK} opacity={0.72} />
);

const Arrow = ({ d }: { d: string }) => (
  <path d={d} fill="none" stroke={RULE} strokeWidth={1} markerEnd="url(#ntw-arrow)" />
);

function Code() {
  const lines: [number, number, number][] = [
    [0, 34, 0.9], [8, 58, 0.55], [8, 44, 0.55], [16, 66, 0.4], [16, 38, 0.4],
    [8, 20, 0.55], [0, 12, 0.9], [0, 0, 0], [0, 46, 0.9], [8, 72, 0.55], [0, 12, 0.9],
  ];
  return (
    <Page h={176} title={58}>
      <Prose y={28} widths={[120, 96]} />
      <rect x={12} y={48} width={126} height={92} rx={4} fill="var(--code-bg)" />
      {lines.map(([indent, w, o], i) =>
        w ? (
          <rect key={i} x={20 + indent} y={57 + i * 7} width={w} height={2.5} rx={1.25} fill="var(--code-fg)" opacity={o} />
        ) : null,
      )}
      <Prose y={150} widths={[112, 70]} />
    </Page>
  );
}

function Flowchart() {
  return (
    <Page h={204} title={72}>
      <rect x={45} y={30} width={60} height={20} rx={5} fill={FILL} stroke={FILL_EDGE} />
      <rect x={55} y={38.5} width={40} height={3} rx={1.5} fill={RULE} />
      <Arrow d="M75 50v12" />
      <path d="M75 64l30 17-30 17-30-17z" fill="var(--background)" stroke={FILL_EDGE} />
      <rect x={63} y={79.5} width={24} height={3} rx={1.5} fill={RULE} />
      <Arrow d="M45 81H31v27" />
      <Arrow d="M105 81h14v27" />
      <rect x={10} y={110} width={46} height={20} rx={5} fill={MINT} stroke={MINT_EDGE} />
      <rect x={20} y={118.5} width={26} height={3} rx={1.5} fill={MINT_EDGE} />
      <rect x={94} y={110} width={46} height={20} rx={5} fill={FILL} stroke={FILL_EDGE} />
      <rect x={104} y={118.5} width={26} height={3} rx={1.5} fill={RULE} />
      <Arrow d="M33 130v14h30" />
      <Arrow d="M117 130v14H87" />
      <rect x={52} y={146} width={46} height={20} rx={5} fill={FILL} stroke={FILL_EDGE} />
      <rect x={62} y={154.5} width={26} height={3} rx={1.5} fill={RULE} />
      <Prose y={180} widths={[118, 84]} />
    </Page>
  );
}

function Table() {
  const rows = [0, 1, 2, 3, 4];
  return (
    <Page h={148} title={64}>
      <Prose y={28} widths={[112]} />
      <rect x={12} y={40} width={126} height={78} rx={3} fill="none" stroke={SOFT} />
      <rect x={12} y={40} width={126} height={13} rx={3} fill="var(--surface)" />
      {rows.map((r) => (
        <g key={r}>
          {r > 0 && <path d={`M12 ${40 + r * 13 + 13}h126`} stroke={SOFT} />}
          {[18, 66, 106].map((x, c) => (
            <rect
              key={c}
              x={x}
              y={45 + r * 13}
              width={r === 0 ? [30, 24, 20][c] : [[38, 16, 24], [30, 22, 14], [42, 12, 26], [26, 20, 18]][r - 1][c]}
              height={3}
              rx={1.5}
              fill={r === 0 ? INK : RULE}
              opacity={r === 0 ? 0.72 : 1}
            />
          ))}
        </g>
      ))}
      <path d="M60 40v78M100 40v78" stroke={SOFT} />
      <Prose y={128} widths={[96]} />
    </Page>
  );
}

function Maths() {
  return (
    <Page h={132} title={50}>
      <Prose y={28} widths={[118, 102]} />
      <text x={75} y={70} textAnchor="middle" fontFamily="'Times New Roman', Times, serif" fontStyle="italic" fontSize={17} fill={INK}>
        σ² = Σ(xᵢ − μ)² ⁄ n
      </text>
      <text x={75} y={93} textAnchor="middle" fontFamily="'Times New Roman', Times, serif" fontStyle="italic" fontSize={12} fill={INK} opacity={0.75}>
        e^(iπ) + 1 = 0
      </text>
      <Prose y={108} widths={[110, 60]} />
    </Page>
  );
}

function Mockup() {
  return (
    <Page h={212} title={54}>
      <rect x={42} y={30} width={66} height={132} rx={10} fill="var(--surface)" stroke={RULE} />
      <rect x={66} y={35} width={18} height={3} rx={1.5} fill={RULE} />
      <rect x={49} y={46} width={52} height={30} rx={4} fill={FILL} />
      <rect x={49} y={82} width={34} height={3.5} rx={1.5} fill={INK} opacity={0.72} />
      <rect x={49} y={90} width={48} height={2.5} rx={1.25} fill={RULE} />
      <rect x={49} y={96} width={40} height={2.5} rx={1.25} fill={RULE} />
      {[0, 1].map((i) => (
        <g key={i}>
          <rect x={49} y={106 + i * 16} width={11} height={11} rx={3} fill={MINT} stroke={MINT_EDGE} />
          <rect x={65} y={110 + i * 16} width={[32, 26][i]} height={2.5} rx={1.25} fill={RULE} />
        </g>
      ))}
      <rect x={49} y={142} width={52} height={13} rx={6.5} fill={INK} />
      <rect x={65} y={147} width={20} height={3} rx={1.5} fill="var(--background)" />
      <path d="M108 60h10M108 120h10" stroke={RULE} strokeDasharray="2 2" />
      <rect x={120} y={57} width={20} height={2.5} rx={1.25} fill={SOFT} />
      <rect x={120} y={117} width={16} height={2.5} rx={1.25} fill={SOFT} />
      <Prose y={176} widths={[120, 94, 66]} />
    </Page>
  );
}

/** Pictures with a horizon: enough to read as photographs, and as different ones. */
function Photo({ x, y, w, h, sky, land, sun }: { x: number; y: number; w: number; h: number; sky: string; land: string; sun?: [number, number] }) {
  const id = `ntw-ph-${x}-${y}`;
  return (
    <g>
      <clipPath id={id}>
        <rect x={x} y={y} width={w} height={h} rx={3} />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        <rect x={x} y={y} width={w} height={h} fill={sky} />
        {sun && <circle cx={x + sun[0]} cy={y + sun[1]} r={5} fill="#fff" opacity={0.85} />}
        <path d={`M${x} ${y + h * 0.68}q${w * 0.28} ${-h * 0.34} ${w * 0.52} ${-h * 0.06}t${w * 0.48} ${-h * 0.12}V${y + h}H${x}z`} fill={land} />
        <path d={`M${x} ${y + h * 0.86}q${w * 0.4} ${-h * 0.2} ${w} ${-h * 0.04}V${y + h}H${x}z`} fill={land} opacity={0.6} />
      </g>
    </g>
  );
}

function Album() {
  return (
    <Page h={168} title={46}>
      <Prose y={28} widths={[104]} />
      <Photo x={12} y={40} w={60} h={74} sky="#c9d8e6" land="#6f8a78" sun={[44, 16]} />
      <Photo x={76} y={40} w={62} h={34} sky="#f0d9c2" land="#b0785c" sun={[14, 12]} />
      <Photo x={76} y={78} w={29} h={36} sky="#dfe6d8" land="#8aa07a" />
      <Photo x={109} y={78} w={29} h={36} sky="#cfd3e8" land="#5d6688" sun={[20, 10]} />
      <Photo x={12} y={118} w={40} h={26} sky="#e8dccb" land="#9a8a6a" />
      <Photo x={56} y={118} w={82} h={26} sky="#bfd6d9" land="#4f7f86" sun={[62, 9]} />
      <Prose y={152} widths={[88]} />
    </Page>
  );
}

function Place() {
  return (
    <Page h={156} title={60}>
      <clipPath id="ntw-map">
        <rect x={12} y={28} width={126} height={88} rx={4} />
      </clipPath>
      <g clipPath="url(#ntw-map)">
        <rect x={12} y={28} width={126} height={88} fill="#eef0ea" />
        <path d="M12 96c28-10 38 8 62-4s34-30 64-22v46H12z" fill="#cfe0ea" />
        <rect x={84} y={34} width={38} height={26} rx={3} fill="#dbe8d2" />
        <path d="M12 58h126M12 80l126-16M46 28v88M98 28l-14 88M12 40l70 76" stroke="#fff" strokeWidth={3.5} />
        <path d="M12 58h126M46 28v88" stroke="#f3e3b8" strokeWidth={1.5} />
        <path d="M70 47c0 8-9 17-9 17s-9-9-9-17a9 9 0 0 1 18 0z" fill={INK} />
        <circle cx={61} cy={47} r={3.2} fill="var(--background)" />
      </g>
      <Sub y={124} w={54} />
      <Prose y={133} widths={[98, 70]} />
    </Page>
  );
}

function Checklist() {
  const done = [true, true, false, false, false];
  return (
    <Page h={140} title={66}>
      <Prose y={28} widths={[116]} />
      {done.map((d, i) => (
        <g key={i}>
          <rect x={12} y={42 + i * 13} width={8} height={8} rx={2} fill={d ? INK : "none"} stroke={d ? INK : RULE} />
          {d && <path d={`M14 ${46 + i * 13}l1.8 1.8 3-3.4`} fill="none" stroke="var(--background)" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />}
          <rect x={26} y={44.5 + i * 13} width={[84, 66, 92, 58, 74][i]} height={2.5} rx={1.25} fill={d ? SOFT : RULE} />
        </g>
      ))}
      <Prose y={114} widths={[100, 52]} />
    </Page>
  );
}

function Graph() {
  const nodes: [number, number, string, string][] = [
    [75, 52, MINT, MINT_EDGE], [30, 84, FILL, FILL_EDGE], [120, 80, FILL, FILL_EDGE],
    [52, 126, FILL, FILL_EDGE], [104, 128, FILL, FILL_EDGE],
  ];
  return (
    <Page h={172} title={52}>
      <path d="M75 52L30 84M75 52l45 28M30 84l22 42M120 80l-16 48M52 126h52M75 52l-23 74" stroke={RULE} fill="none" />
      {nodes.map(([x, y, f, s], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={i === 0 ? 13 : 10} fill={f} stroke={s} />
          <rect x={x - 6} y={y - 1.5} width={12} height={3} rx={1.5} fill={s} />
        </g>
      ))}
      <rect x={100} y={30} width={38} height={26} rx={2} fill="#f7ecb8" transform="rotate(4 119 43)" />
      <Prose y={36} x={105} widths={[26, 20]} />
      <Prose y={150} widths={[112, 78]} />
    </Page>
  );
}

function Storyboard() {
  return (
    <Page h={150} title={62}>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={12 + i * 43} y={30} width={40} height={28} rx={2} fill="var(--surface)" stroke={RULE} />
          <path d={[`M18 52l8-10 6 6 5-4 9 8`, `M61 52c6-14 22-14 28 0`, `M106 38h24M106 44h16M106 50h20`][i]} fill="none" stroke={RULE} />
          <Prose y={64} x={12 + i * 43} widths={[36, 26]} />
        </g>
      ))}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={12 + i * 43} y={84} width={40} height={28} rx={2} fill="var(--surface)" stroke={RULE} />
          <circle cx={32 + i * 43} cy={98} r={[7, 4, 9][i]} fill="none" stroke={RULE} />
          <Prose y={118} x={12 + i * 43} widths={[32, 22]} />
        </g>
      ))}
    </Page>
  );
}

function Notes() {
  return (
    <Page h={124} title={70}>
      <Prose y={28} widths={[122, 116, 90]} />
      <Sub y={56} w={44} />
      <path d="M13 68v22" stroke={INK} strokeWidth={2} opacity={0.5} />
      <Prose y={69} x={20} widths={[104, 96, 60]} />
      <Prose y={100} widths={[118, 76]} />
    </Page>
  );
}

function Outline() {
  const rows: [number, number, boolean][] = [
    [0, 52, true], [10, 86, false], [10, 70, false], [20, 58, false],
    [0, 44, true], [10, 92, false], [10, 64, false],
  ];
  return (
    <Page h={130} title={48}>
      {rows.map(([indent, w, head], i) => (
        <g key={i}>
          {!head && <circle cx={15 + indent} cy={33.2 + i * 12} r={1.4} fill={RULE} />}
          <rect
            x={(head ? 12 : 21) + indent}
            y={(head ? 31.5 : 32) + i * 12}
            width={w}
            height={head ? 3.5 : 2.5}
            rx={1.25}
            fill={head ? INK : SOFT}
            opacity={head ? 0.72 : 1}
          />
        </g>
      ))}
    </Page>
  );
}

/** Three courses, each starting at a different height — which is what makes it
 *  brick — and every page on the wall a different one. */
const COURSES: { lift: number; pages: ReactNode[] }[] = [
  { lift: -40, pages: [<Table key="t" />, <Mockup key="m" />, <Maths key="x" />, <Storyboard key="s" />] },
  { lift: -84, pages: [<Notes key="n" />, <Code key="c" />, <Album key="a" />, <Flowchart key="f" />] },
  { lift: -16, pages: [<Graph key="g" />, <Place key="p" />, <Checklist key="k" />, <Outline key="o" />] },
];

export function TemplateWall() {
  return (
    <div className="nt-wall" aria-hidden="true">
      <svg width="0" height="0" className="absolute">
        <defs>
          <marker id="ntw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto">
            <path d="M1 1l6 3-6 3" fill="none" stroke={RULE} strokeWidth={1.4} />
          </marker>
        </defs>
      </svg>
      <div className="nt-wall-courses">
        {COURSES.map((course, c) => (
          <div key={c} className="nt-wall-course" style={{ marginTop: course.lift }} data-dir={c % 2 ? "down" : "up"}>
            {course.pages.map((page, i) => (
              <div key={i} className="nt-wall-brick" style={{ "--i": c + i * 3 } as React.CSSProperties}>
                {page}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
