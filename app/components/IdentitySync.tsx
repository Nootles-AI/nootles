"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/nextjs";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { confirmEmail, RETRY_DELAYS_MS, type Confirmation } from "@/app/lib/confirmEmail";
import { impersonationToken } from "@/app/lib/impersonation";
import { useStandIn } from "./StandIn";

type Check = {
  /** Undefined while this session's address is still being confirmed. */
  confirmed: string | null | undefined;
  /** False when the last word was no word at all: nobody answered the check. */
  answered: boolean;
  /** True while a `recheck` is out. */
  checking: boolean;
  /** Asks again, retrying as a first visit does. */
  recheck: () => void;
};

const IdentityContext = createContext<Check>({
  confirmed: undefined,
  answered: true,
  checking: false,
  recheck: () => {},
});

/**
 * How long a tab goes before coming back to it asks again. A session outlives
 * the server's day-old re-check, and an address it has not re-checked in a
 * few days admits nobody.
 */
const REASK_MS = 60 * 60 * 1000;

/**
 * The address the server confirmed for this session, null for none, or
 * undefined while it is still asking. A surface that would tell someone their
 * address is missing or wrong waits for this first: on a first visit the
 * confirmation lands a moment after the page does.
 */
export function useConfirmedEmail(): string | null | undefined {
  return useContext(IdentityContext).confirmed;
}

/**
 * Why there is no confirmed address, and a way to ask again: a surface that
 * says so words "we couldn't check" differently from "your sign-in didn't
 * say".
 */
export function useIdentityCheck(): Omit<Check, "confirmed"> {
  const { answered, checking, recheck } = useContext(IdentityContext);
  return { answered, checking, recheck };
}

/**
 * Asks the server to confirm who this session is (`identity.sync`) when a
 * signed-in session starts, and again when the tab comes back into view an
 * hour or more later. Clerk's session token names only the account, so the
 * address that invitations and join domains are bound to comes from the
 * server's own word with Clerk, never from this tab. A first ask that gets no
 * answer is retried a couple of times before it settles as unanswered.
 *
 * Not for an operator standing in: the server refuses them, and their session
 * has nothing of its own to confirm.
 */
export function IdentitySync({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const { sessionId } = useAuth();
  const standIn = useStandIn();
  const sync = useAction(api.identity.sync);
  const asking = useRef<{ session: string; at: number; controller: AbortController } | null>(
    null,
  );
  const [answer, setAnswer] = useState<({ session: string } & Confirmation) | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  const ask = useCallback(
    (session: string, retry: boolean) => {
      asking.current?.controller.abort();
      const controller = new AbortController();
      asking.current = { session, at: Date.now(), controller };
      return confirmEmail(() => sync({}), controller.signal, retry ? RETRY_DELAYS_MS : []).then(
        (result) => {
          // A failed re-ask keeps the answer already given.
          if (result && (result.answered || retry)) setAnswer({ session, ...result });
        },
      );
    },
    [sync],
  );

  useEffect(() => {
    if (!isAuthenticated || !sessionId || impersonationToken()) return;
    if (asking.current?.session !== sessionId) void ask(sessionId, true);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - (asking.current?.at ?? 0) >= REASK_MS) void ask(sessionId, false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isAuthenticated, sessionId, ask]);

  const recheck = useCallback(() => {
    if (!sessionId || standIn || impersonationToken()) return;
    setChecking(sessionId);
    void ask(sessionId, true).finally(() =>
      setChecking((current) => (current === sessionId ? null : current)),
    );
  }, [ask, sessionId, standIn]);

  const mine = !standIn && answer?.session === sessionId ? answer : null;
  const check = useMemo<Check>(
    () => ({
      confirmed: standIn ? null : mine ? mine.email : undefined,
      answered: mine?.answered ?? true,
      checking: checking !== null && checking === sessionId,
      recheck,
    }),
    [standIn, mine, checking, sessionId, recheck],
  );
  return <IdentityContext value={check}>{children}</IdentityContext>;
}
