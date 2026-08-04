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
/** Past this the page is below the crop, and the stagger has no delay left. */
const MAX_BLOCKS = 14;

/**
 * First run.
 *
 * Three questions, and the reward for answering them is a project that is
 * already about something. That is the whole reason this is allowed to exist
 * before the product: a survey that only collected answers would be a toll
 * gate, but every answer here does work — one picks the document, one primes
 * the model, and one sets a page setting the user would otherwise meet cold.
 *
 * The page on the right is the argument. It assembles as the questions are
 * answered, so what is being asked for is never abstract.
 */
export function Welcome() {
  const router = useRouter();
  const create = useMutation(api.onboarding.createSeededProject);
  const skip = useMutation(api.profiles.skip);

  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState<Template | null>(null);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const leave = async () => {
    await skip().catch(() => {});
    router.push("/");
  };

  const open = async (mode: Mode) => {
    if (!template || busy) return;
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
      });
      router.push(`/p/${projectId}`);
    } catch (error) {
      // The answers are all still here, so this is something to try again.
      setFailure((error as Error).message);
      setBusy(false);
    }
  };

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
              title="What are you planning?"
              note="Pick whichever is closest. Nothing here is permanent."
            >
              <div className="nt-wc-grid">
                {TEMPLATES.map((option) => (
                  <button
                    key={option.id}
                    className={`nt-wc-card${template?.id === option.id ? " is-on" : ""}`}
                    onClick={() => {
                      setTemplate(option);
                      setRole("");
                      setStep(1);
                    }}
                  >
                    <span className="nt-wc-card-label">{option.label}</span>
                    <span className="nt-wc-card-blurb">{option.blurb}</span>
                  </button>
                ))}
              </div>
            </Question>
          )}

          {step === 1 && template && (
            <Question
              title="And what do you do?"
              note="This goes into the project's context, so the model has something better than a guess to work from."
            >
              <div className="nt-wc-chips">
                {template.roles.map((option) => (
                  <button
                    key={option}
                    className="nt-wc-chip"
                    onClick={() => {
                      setRole(option);
                      setStep(2);
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
                  if (role.trim()) setStep(2);
                }}
              >
                <input
                  className="nt-wc-input"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="Or say it in your own words"
                  aria-label="Your role, in your own words"
                />
                <button className="nt-wc-go" disabled={!role.trim()}>
                  Continue
                </button>
              </form>
            </Question>
          )}

          {step === 2 && (
            <Question
              title="How much should Nootles write?"
              note="It is a setting on every page, so this only picks where you start."
            >
              <div className="nt-wc-modes">
                <button
                  className="nt-wc-mode"
                  disabled={busy}
                  onClick={() => void open("create")}
                >
                  <span className="nt-wc-mode-label">Write with me</span>
                  <span className="nt-wc-mode-note">
                    It drafts what is not there yet — sections, diagrams, code —
                    and you keep what you want.
                  </span>
                </button>
                <button
                  className="nt-wc-mode"
                  disabled={busy}
                  onClick={() => void open("complete")}
                >
                  <span className="nt-wc-mode-label">Only finish what I start</span>
                  <span className="nt-wc-mode-note">
                    It completes the line you are on and stays quiet otherwise.
                    Better for notes on something.
                  </span>
                </button>
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

      <aside className="nt-wc-desk" aria-hidden>
        <Paper template={template} />
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
 * The page, at the size it will really be, shrunk onto the desk.
 *
 * Keyed on the template so choosing a different one replays the assembly —
 * that motion is the answer to "what am I actually getting", and a cross-fade
 * between two static pictures would not be one.
 */
function Paper({ template }: { template: Template | null }) {
  if (!template) {
    return (
      <div className="nt-wc-paper is-blank">
        <span className="nt-thumb-blank" />
      </div>
    );
  }
  const blocks = preview(template.pages[0].blocks).slice(0, MAX_BLOCKS);
  return (
    <div className="nt-wc-paper">
      <div className="nt-wc-page" key={template.id} style={{ width: DOC_WIDTH }}>
        <PreviewBlocks blocks={blocks} />
      </div>
    </div>
  );
}

/**
 * Template blocks in the shape the page renderer reads.
 *
 * Seeds are written with plain strings for their text, because that is how a
 * template is legible to whoever edits it; the renderer wants the inline array
 * a real document holds. One conversion, here, rather than a second spelling
 * of every template.
 */
function preview(blocks: readonly SeedBlock[]): AnyBlock[] {
  return blocks.map((block, i) => ({
    id: block.id ?? `seed-${i}`,
    type: String(block.type ?? "paragraph"),
    props: (block.props ?? {}) as Record<string, unknown>,
    content:
      typeof block.content === "string"
        ? [{ type: "text", text: block.content, styles: {} }]
        : block.content,
  }));
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
