"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Wordmark } from "@/app/components/Brand";
import { PreviewBlocks } from "@/app/components/PagePreview";
import { TEMPLATES, templateById } from "@/app/lib/onboarding/templates";
import {
  declaredHeight,
  examplePage,
  openingOf,
} from "@/app/lib/onboarding/preview";
import type { Template, TemplateId } from "@/app/lib/onboarding/types";
import { TemplateMark } from "./TemplateMark";
import "./welcome.css";

type Mode = "create" | "complete";

/** Whether the seed module's download has already been started. See `warm`. */
let warmed = false;

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
  /** The template being built, which is also what "busy" means here. */
  const [busy, setBusy] = useState<Template | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const leave = async () => {
    await skip().catch(() => {});
    router.push("/");
  };

  /**
   * Start pulling the editor down while they are still reading.
   *
   * `seed` drags BlockNote in behind it, which is the heaviest chunk in the
   * app, and nothing else on this route wants it. Left until the click, the
   * download lands inside the one wait the user actually feels; started when
   * the template question appears, it is usually finished before they have
   * decided. Latched at module scope so it happens once per page load.
   */
  const warm = () => {
    if (warmed) return;
    warmed = true;
    void import("@/app/lib/onboarding/seed").catch(() => {
      // Only a head start. The click imports it again and reports for real.
      warmed = false;
    });
  };

  const open = async (template: Template) => {
    if (busy) return;
    setBusy(template);
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
      // The answers are all still here, so this is something to try again — and
      // that is what to say. What the server threw is a request id and a stack
      // frame, which is the wrong thing to hand somebody who has just answered
      // three questions and committed to one of six cards; it goes to the
      // console, where the person who can act on it will look.
      console.error("[nootles] first run could not build the project", error);
      setFailure("That did not go through. Your answers are still here — pick it again.");
      setBusy(null);
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
    // Once one is being built the sheet holds still on it, whatever the pointer
    // is doing. This is the page that is about to arrive for real.
    busy ??
    (step === 2
      ? (hovered ?? templateForRole(role) ?? TEMPLATES[0])
      : (templateForRole(hoverRole ?? role) ?? TEMPLATES[0]));
  // Held until the pointer picks one, so the demo does not run unasked.
  const demo = step === 1 ? hoverMode : null;

  return (
    // Committing: the questions have done their job and the eye is already on
    // the page, so the form recedes and the sheet is the last thing standing.
    // What replaces this screen is that document, and the handover reads better
    // if the picture of it is what the user is still looking at when it does.
    <main className={`nt-wc${busy ? " is-committing" : ""}`}>
      <section className="nt-wc-ask">
        <header className="nt-wc-head">
          <Wordmark role="img" aria-label="Nootles" className="nt-wc-mark" />
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
                    warm();
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
                    warm();
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
                    disabled={busy !== null}
                    onPointerEnter={() => setHovered(option)}
                    onFocus={() => setHovered(option)}
                    onClick={() => void open(option)}
                  >
                    <TemplateMark id={option.id} />
                    <span className="nt-wc-card-text">
                      <span className="nt-wc-card-label">{option.label}</span>
                      <span className="nt-wc-card-blurb">{option.blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
              {/* One row, always present. The column above it is centred, so a
                  line that mounts on click lifts the question by half a line at
                  the exact moment the user is looking to see whether anything
                  happened. */}
              <p
                className={`nt-wc-status${failure ? " is-failure" : ""}`}
                role="status"
                aria-live="polite"
              >
                {failure ?? (busy ? "Building your project…" : "")}
              </p>
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
          <div className="nt-sheet" aria-hidden>
            <div
              className="nt-sheet-page"
              key={`${shown.id}:${demo ?? "doc"}`}
            >
              {demo ? (
                <>
                  <PreviewBlocks blocks={openingOf(shown)} />
                  <ModeDemo key={demo} mode={demo} template={shown} />
                </>
              ) : (
                <PreviewBlocks
                  blocks={examplePage(shown)}
                  diagramHeight={declaredHeight(shown.script.draw.html)}
                />
              )}
            </div>
          </div>
        )}
        {/* The picture cannot say what it is a picture OF — and once the choice
            is made it stops being a picture of anything and starts being a
            report on what is happening, which is where the eye already is. */}
        <p className="nt-sheet-caption">
          {busy
            ? `Setting up ${busy.projectTitle}…`
            : step === 0
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
  const settled = typed.length >= ghost.length;

  /**
   * The drawing follows the sentence, and follows it immediately.
   *
   * In sequence because that is the order it happens in — the model finishes
   * the line, then keeps going and proposes a block — and the whole point of
   * this mode is that it does not stop at the clause. But with no pause held
   * between them: the beat that used to sit there turned one continuous answer
   * into two events, and on a question answered by hovering the viewer has
   * usually moved on before the second one arrives.
   */
  const drawn = mode === "create" && settled;

  useEffect(() => {
    let at = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      // A word and the space before it, which is roughly what a token is.
      at = Math.min(at + (ghost.slice(at).match(/^\s*\S+/)?.[0].length ?? 1), ghost.length);
      setTyped(ghost.slice(0, at));
      if (at < ghost.length) timer = setTimeout(step, 30 + Math.random() * 46);
    };
    timer = setTimeout(step, 420);
    return () => clearTimeout(timer);
  }, [ghost]);

  /* The app's own "still generating" mark: pulsing while tokens arrive, steady
     once it is showing where the caret would land. */
  const head = <span className={`nt-stream-head${settled ? "" : " is-live"}`} />;

  return (
    <>
      <p className="nt-wc-demo-line">
        {lead}
        <span className="nt-wc-ghost">{typed}</span>
        {/* Only when the line is the whole of what it wrote. In the other mode
            the caret belongs after the drawing, which is further down. */}
        {!drawn && head}
      </p>
      {drawn && (
        <div className="nt-wc-demo-drawn">
          {/* Ghosted like the clause above it, because it is the same kind of
              thing: proposed, not placed. The line and the picture under it are
              one suggestion, and colouring the words as settled text while the
              drawing is still an offer would split them. */}
          <p className="nt-wc-demo-line nt-wc-ghost">
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
          {/* Where the next keystroke would land. In this mode the last thing
              the model wrote is a picture, so the caret is under it — which is
              the whole difference from the other answer, said without a word. */}
          <p className="nt-wc-demo-caret">{head}</p>
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
