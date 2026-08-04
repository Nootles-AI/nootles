"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PreviewBlocks } from "@/app/components/PagePreview";
import { TEMPLATES, templateById } from "@/app/lib/onboarding/templates";
import type {
  SeedBlock,
  Template,
  TemplateId,
} from "@/app/lib/onboarding/types";
import type { AnyBlock } from "@/app/lib/ai/projection";
import "./welcome.css";

type Mode = "create" | "complete";

/** What the document is written at; the preview lays out here and is scaled. */
const DOC_WIDTH = 600;

/**
 * Each role paired with the document that role actually produces.
 *
 * Asked before the templates, so the roles can be generic without being vague:
 * a role means the same thing whether you are writing a spec or planning a
 * table. The pairing is what makes the question visibly do something — answer
 * it and the page on the desk becomes the kind of page you would be writing.
 * Picking the template later is still the real choice; this only stops the
 * first answer disappearing into a form.
 */
const ROLES: ReadonlyArray<{ label: string; template: TemplateId }> = [
  { label: "Engineer", template: "techDesign" },
  { label: "Product or program", template: "prd" },
  { label: "Design", template: "prd" },
  { label: "Research or analysis", template: "research" },
  { label: "Student or teacher", template: "classNotes" },
  { label: "Writing something", template: "screenplay" },
];

function templateForRole(role: string | null): Template | null {
  if (!role) return null;
  const found = ROLES.find((r) => r.label === role);
  return found ? (templateById(found.template) ?? null) : null;
}

/**
 * First run.
 *
 * Three questions, and the reward for answering them is a project that is
 * already about something. That is the whole reason this is allowed to exist
 * before the product: a survey that only collected answers would be a toll
 * gate, but every answer here does work — one primes the model, one sets a
 * page setting the user would otherwise meet cold, and one picks the document.
 *
 * The page on the right is the argument, and it is making it from the first
 * question rather than waiting to be asked: prose, a diagram, and maths or
 * code, on one page, before anybody has had to explain what any of that means.
 */
export function Welcome() {
  const router = useRouter();
  const create = useMutation(api.onboarding.createSeededProject);
  const skip = useMutation(api.profiles.skip);

  const [step, setStep] = useState(0);
  const [role, setRole] = useState("");
  const [mode, setMode] = useState<Mode>("create");
  const [hovered, setHovered] = useState<Template | null>(null);
  const [hoverRole, setHoverRole] = useState<string | null>(null);
  const [hoverMode, setHoverMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const leave = async () => {
    await skip().catch(() => {});
    router.push("/");
  };

  const open = async (template: Template) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // BlockNote is the heaviest thing in the app and this route has no other
      // use for it — the preview draws from plain block data.
      const { docFromBlocks } = await import("@/app/lib/onboarding/seed");
      const projectId = await create({
        title: template.projectTitle,
        description: template.description,
        template: template.id,
        role: role.trim() || undefined,
        useCase: template.label,
        defaultMode: mode,
        pages: template.pages.map((page) => ({
          title: page.title,
          doc: docFromBlocks(page.blocks),
        })),
        context: sheet(template, role),
        priorChat: template.script.priorChat,
      });
      router.push(`/p/${projectId}`);
    } catch (error) {
      // The answers are all still here, so this is something to try again.
      setFailure((error as Error).message);
      setBusy(false);
    }
  };

  /**
   * What is on the desk, and what it is doing.
   *
   * Every step answers with the page: the role question turns it into the kind
   * of document that role writes, the mode question performs the difference
   * between the two answers on it, and the template question swaps it outright.
   * A sheet that sat still through the first two would be telling the user
   * their first two answers went nowhere.
   */
  const shown =
    step === 2
      ? (hovered ?? templateForRole(role) ?? TEMPLATES[0])
      : (templateForRole(hoverRole ?? role) ?? TEMPLATES[0]);
  // Held until the pointer picks one, so the demo does not run unasked.
  const demo = step === 1 ? hoverMode : null;

  return (
    <main className="nt-wc">
      <section className="nt-wc-ask">
        <header className="nt-wc-head">
          <span className="nt-wc-mark">Nootles</span>
          <button className="nt-wc-out" onClick={() => void leave()}>
            I&rsquo;ll look around on my own
          </button>
        </header>

        <div className="nt-wc-body" key={step}>
          {step === 0 && (
            <Question
              title="What do you do?"
              note="It goes into the project's context, so the model has something better than a guess to work from."
            >
              <div className="nt-wc-chips">
                {ROLES.map((option) => (
                  <button
                    key={option.label}
                    className={`nt-wc-chip${role === option.label ? " is-on" : ""}`}
                    onPointerEnter={() => setHoverRole(option.label)}
                    onFocus={() => setHoverRole(option.label)}
                    onPointerLeave={() => setHoverRole(null)}
                    onClick={() => {
                      setRole(option.label);
                      setStep(1);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <form
                className="nt-wc-own"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (role.trim()) setStep(1);
                }}
              >
                <input
                  className="nt-wc-input"
                  value={role}
                  // Typing wins over a hover. A pointer left resting on a chip
                  // otherwise keeps answering the context sheet on the user's
                  // behalf while they are busy writing a different answer into
                  // it — which is the one moment this panel must not get wrong,
                  // since its whole job is to show that what you say is kept.
                  onChange={(e) => {
                    setHoverRole(null);
                    setRole(e.target.value);
                  }}
                  onFocus={() => setHoverRole(null)}
                  placeholder="Or say it in your own words"
                  aria-label="What you do, in your own words"
                />
                <button className="nt-wc-go" disabled={!role.trim()}>
                  Continue
                </button>
              </form>
            </Question>
          )}

          {step === 1 && (
            <Question
              title="How much should Nootles write?"
              note="It is a setting on every page, so this only picks where you start."
            >
              <div className="nt-wc-modes">
                <button
                  className="nt-wc-mode"
                  onPointerEnter={() => setHoverMode("create")}
                  onFocus={() => setHoverMode("create")}
                  onClick={() => {
                    setMode("create");
                    setStep(2);
                  }}
                >
                  <span className="nt-wc-mode-label">Write with me</span>
                  <span className="nt-wc-mode-note">
                    It drafts what is not there yet — sections, diagrams, code —
                    and you keep what you want.
                  </span>
                </button>
                <button
                  className="nt-wc-mode"
                  onPointerEnter={() => setHoverMode("complete")}
                  onFocus={() => setHoverMode("complete")}
                  onClick={() => {
                    setMode("complete");
                    setStep(2);
                  }}
                >
                  <span className="nt-wc-mode-label">Only finish what I start</span>
                  <span className="nt-wc-mode-note">
                    It completes the line you are on and stays quiet otherwise.
                    Better for notes on something.
                  </span>
                </button>
              </div>
            </Question>
          )}

          {step === 2 && (
            <Question
              title="What's a good example of something you'd use Nootles for?"
              note="Hover to see it. Pick one and we will set it up for real — nothing here is permanent."
            >
              <div className="nt-wc-grid">
                {TEMPLATES.map((option) => (
                  <button
                    key={option.id}
                    className={`nt-wc-card${shown.id === option.id ? " is-on" : ""}`}
                    disabled={busy}
                    onPointerEnter={() => setHovered(option)}
                    onFocus={() => setHovered(option)}
                    onClick={() => void open(option)}
                  >
                    <span className="nt-wc-card-label">{option.label}</span>
                    <span className="nt-wc-card-blurb">{option.blurb}</span>
                  </button>
                ))}
              </div>
              {busy && <p className="nt-wc-busy">Building your project…</p>}
              {failure && (
                <p className="nt-wc-failure" role="alert">
                  {failure}
                </p>
              )}
            </Question>
          )}
        </div>

        <footer className="nt-wc-foot">
          <div className="nt-wc-dots" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`nt-wc-dot${i === step ? " is-on" : ""}${i < step ? " is-past" : ""}`}
              />
            ))}
          </div>
          {step > 0 && !busy && (
            <button className="nt-wc-back" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
        </footer>
      </section>

      <aside className="nt-wc-desk">
        {/* One artifact per question, and a different one each time. The role
            question is answered by the context sheet because that is literally
            where the answer goes; the mode question is answered by watching the
            two modes behave; the template question is answered by the page. A
            single picture doing all three would be three questions with one
            answer. */}
        {step === 0 ? (
          <ContextCard role={hoverRole ?? role} template={shown} />
        ) : (
          <div className="nt-wc-paper" aria-hidden>
            <div
              className="nt-wc-page"
              key={`${shown.id}:${demo ?? "doc"}`}
              style={{ width: DOC_WIDTH }}
            >
              {demo ? (
                <>
                  <PreviewBlocks blocks={opening(shown)} />
                  <ModeDemo key={demo} mode={demo} template={shown} />
                </>
              ) : (
                <PreviewBlocks
                  blocks={example(shown)}
                  diagramHeight={declaredHeight(shown.script.draw.html)}
                />
              )}
            </div>
          </div>
        )}
        {/* The picture cannot say what it is a picture OF. */}
        <p className="nt-wc-caption">
          {step === 0
            ? "Every question the model is asked starts with this."
            : demo
              ? DEMO_CAPTION[demo]
              : shown.showcase.caption}
        </p>
      </aside>
    </main>
  );
}

/**
 * The project's context sheet, filling in as the question is answered.
 *
 * This is where the role answer literally goes, so it is the honest thing to
 * show — and it is a different object from a document page, which matters:
 * three questions answered by three views of the same page would read as one
 * question asked three times.
 *
 * Live while typing, not on submit. The point being made is that what you say
 * here is kept and used, and a field that only fills in after you commit makes
 * that point a beat too late to land.
 */
function ContextCard({ role, template }: { role: string; template: Template }) {
  const said = role.trim();
  return (
    <div className="nt-wc-context">
      <span className="nt-wc-context-label">Project context</span>
      <dl className="nt-wc-context-rows">
        <div className="nt-wc-context-row">
          <dt>What is this project?</dt>
          <dd>{template.description}</dd>
        </div>
        <div className="nt-wc-context-row">
          <dt>Who is writing it, and what do they do?</dt>
          <dd className={said ? "" : "is-waiting"}>
            {said || "…"}
            <span className="nt-wc-caret" />
          </dd>
        </div>
      </dl>
    </div>
  );
}

const DEMO_CAPTION: Record<Mode, string> = {
  create: "It writes what is not there yet, and shows you before anything lands.",
  complete: "It finishes the line you are on, and then it stops.",
};

/**
 * The two answers, performed on the page rather than described beside it.
 *
 * The difference between the modes is genuinely hard to say in a sentence —
 * both of them "complete text" — and it is obvious in one second of watching:
 * one finishes your clause and stops, the other keeps going and proposes a
 * whole block. So the page finishes the clause either way, and only one of
 * them goes on to draw something.
 *
 * Remounted per mode by its key, so the typing starts from nothing each time
 * rather than needing to reset itself on the way in.
 */
function ModeDemo({ mode, template }: { mode: Mode; template: Template }) {
  const lead = seedOf(template, template.script.write.blockId);
  const ghost = template.script.write.ghost;
  const [typed, setTyped] = useState("");
  const [drawn, setDrawn] = useState(false);
  const settled = typed.length >= ghost.length;

  useEffect(() => {
    let at = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      // A word and the space before it, which is roughly what a token is.
      at = Math.min(at + (ghost.slice(at).match(/^\s*\S+/)?.[0].length ?? 1), ghost.length);
      setTyped(ghost.slice(0, at));
      if (at < ghost.length) timer = setTimeout(step, 30 + Math.random() * 46);
      else if (mode === "create") timer = setTimeout(() => setDrawn(true), 360);
    };
    timer = setTimeout(step, 420);
    return () => clearTimeout(timer);
  }, [ghost, mode]);

  return (
    <>
      <p className="nt-wc-demo-line">
        {lead}
        <span className="nt-wc-ghost">{typed}</span>
        {/* The app's own "still generating" mark: pulsing while tokens arrive,
            steady once it is showing where the caret would land. */}
        <span className={`nt-stream-head${settled ? "" : " is-live"}`} />
      </p>
      {drawn && (
        <div className="nt-wc-demo-drawn">
          <p className="nt-wc-demo-line">
            {seedOf(template, template.script.draw.blockId)}
          </p>
          <PreviewBlocks
            blocks={[
              {
                id: "demo-diagram",
                type: "canvas",
                props: { data: template.script.draw.html },
              },
            ]}
            // Its own height, capped: the demo has room for a diagram but not
            // for a full-page one, and fitted much below this the labels stop
            // being words — which turns "it drew something" into "something
            // grey appeared".
            diagramHeight={Math.min(declaredHeight(template.script.draw.html) ?? 340, 340)}
          />
        </div>
      )}
    </>
  );
}

/** What a template wrote into one of its blocks, before anybody touched it. */
function seedOf(template: Template, blockId: string): string {
  for (const page of template.pages) {
    for (const block of page.blocks) {
      if (block.id === blockId && typeof block.content === "string") {
        return block.content;
      }
    }
  }
  return "";
}

/** The page down to the line the demo is about to finish. */
function opening(template: Template): AnyBlock[] {
  const blocks = template.pages[0].blocks;
  const at = blocks.findIndex((b) => b.id === template.script.write.blockId);
  return blocks
    .slice(0, at === -1 ? 2 : at)
    // The block the slash beat fills in is empty by design; an empty paragraph
    // in a picture of a page is just a gap nobody can read as anything.
    .filter((b) => b.id !== "nt-tour-slash")
    .map(toAny);
}

function Question({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="nt-wc-q">
      <h1 className="nt-wc-title">{title}</h1>
      <p className="nt-wc-note">{note}</p>
      {children}
    </div>
  );
}

/**
 * A short, finished version of the template's page.
 *
 * Not the document that gets seeded, and deliberately so: the seed is a
 * starting point with the diagram still to come, while this has to answer
 * "what is a Nootles page" in one glance. So it takes the real opening, jumps
 * to the line that wants a picture, draws the picture, and ends on the code,
 * maths or table that kind of document reaches for.
 *
 * Built from the template rather than authored twice, so the promise made here
 * cannot drift away from the project that arrives.
 */
function example(template: Template): AnyBlock[] {
  const blocks = template.pages[0].blocks;
  const at = blocks.findIndex((b) => b.id === template.script.draw.blockId);
  const opening = [blocks[0], blocks[1], ...(at > 0 ? [blocks[at - 1], blocks[at]] : [])];
  const { heading, block } = template.showcase;

  return [
    ...opening.map(toAny),
    { id: "ex-diagram", type: "canvas", props: { data: template.script.draw.html } },
    {
      id: "ex-heading",
      type: "heading",
      props: { level: 2 },
      content: [{ type: "text", text: heading, styles: {} }],
    },
    {
      id: "ex-showcase",
      type: block.type,
      props: block.props ?? {},
      content: block.content,
    },
  ];
}

/**
 * The height the diagram declares for itself, so its box is the size of the
 * drawing rather than a number chosen for a thumbnail.
 *
 * `ScenePreview` fits its content to whatever box it is given: too short and
 * the drawing shrinks away from its own labels, too late and it resizes after
 * the page has settled. Handing it the authored height makes the fit an
 * identity and both problems stop existing.
 */
function declaredHeight(html: string): number | undefined {
  const found = /<nt-diagram[^>]*\bh="(\d+(?:\.\d+)?)"/i.exec(html);
  return found ? Number(found[1]) : undefined;
}

/**
 * A template block in the shape the page renderer reads.
 *
 * Seeds are written with plain strings for their text, because that is how a
 * template stays legible to whoever edits it; the renderer wants the inline
 * array a real document holds.
 */
function toAny(block: SeedBlock, i: number): AnyBlock {
  return {
    id: block.id ?? `seed-${i}`,
    type: String(block.type ?? "paragraph"),
    props: (block.props ?? {}) as Record<string, unknown>,
    content:
      typeof block.content === "string"
        ? [{ type: "text", text: block.content, styles: {} }]
        : block.content,
  };
}

/** The survey's answers, phrased as the Q&A the Context Sheet holds. */
function sheet(template: Template, role: string) {
  const entries = [
    { question: "What is this project?", answer: template.description },
  ];
  const said = role.trim();
  if (said) {
    entries.push({
      question: "Who is writing it, and what do they do?",
      answer: said,
    });
  }
  return entries;
}
