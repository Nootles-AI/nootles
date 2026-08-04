"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PreviewBlocks } from "@/app/components/PagePreview";
import { TEMPLATES } from "@/app/lib/onboarding/templates";
import type { SeedBlock, Template } from "@/app/lib/onboarding/types";
import type { AnyBlock } from "@/app/lib/ai/projection";
import "./welcome.css";

type Mode = "create" | "complete";

/** What the document is written at; the preview lays out here and is scaled. */
const DOC_WIDTH = 600;

/**
 * Asked before the templates, so they can be generic without being vague. A
 * role means the same thing whether you are writing a spec or planning a table,
 * and asking it after the template would only let it be narrower, not truer.
 */
const ROLES = [
  "Engineer",
  "Product or program",
  "Design",
  "Research or analysis",
  "Student or teacher",
  "Writing something",
];

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

  // Never empty: the desk is the argument, so it shows one before it has been
  // told which one to show.
  const shown = hovered ?? TEMPLATES[0];

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
                    key={option}
                    className="nt-wc-chip"
                    onClick={() => {
                      setRole(option);
                      setStep(1);
                    }}
                  >
                    {option}
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
                  onChange={(e) => setRole(e.target.value)}
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
        <div className="nt-wc-paper" aria-hidden>
          <div className="nt-wc-page" key={shown.id} style={{ width: DOC_WIDTH }}>
            <PreviewBlocks
              blocks={example(shown)}
              diagramHeight={declaredHeight(shown.script.draw.html)}
            />
          </div>
        </div>
        {/* The picture cannot say what it is a picture OF. */}
        <p className="nt-wc-caption">{shown.showcase.caption}</p>
      </aside>
    </main>
  );
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
