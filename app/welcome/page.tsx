import type { Metadata } from "next";
import { Authed } from "@/app/components/Authed";
import { Welcome } from "@/app/components/welcome/Welcome";

export const metadata: Metadata = {
  title: "Welcome — Nootles",
};

/**
 * First run. Reachable on purpose rather than only by redirect: it is also the
 * shortest way to start a project from a template, which is a thing worth being
 * able to do twice.
 */
export default function WelcomePage() {
  return (
    <Authed>
      <Welcome />
    </Authed>
  );
}
