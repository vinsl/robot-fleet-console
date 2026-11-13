/**
 * UI state of the authentication: whether the user is signed in, with which role, and which step is pending.
 *
 * The store mirrors the authentication client; it never holds a token. The role here only decides what the
 * UI shows. The API checks the token again on every request.
 */
import { create } from "zustand";
import type { Role } from "@mfc/protocol";
import type { AuthStep, Session, SignOutReason } from "./cognito-client";
import { roleFromGroups } from "./roles";

/** Where the user is in the authentication lifecycle. */
export type AuthStatus = "anonymous" | "authenticating" | "authenticated";

/** Observable authentication state. */
export interface AuthState {
  /** Lifecycle status. */
  readonly status: AuthStatus;
  /** Effective role, or `null` when signed out. */
  readonly role: Role | null;
  /** Step of the sign-in sequence the user is in, or `null`. */
  readonly step: AuthStep | null;
  /** Cognito subject of the signed-in user, or `null`. Shown only to say "acknowledged by you". */
  readonly userId: string | null;
  /** Why the last session ended by expiry, so the sign-in view can say so. */
  readonly signOutReason: SignOutReason | null;
  /** Marks that a sign-in attempt started. */
  beginSignIn(): void;
  /**
   * Records the step of the sign-in sequence.
   *
   * @param step - The step to show, or `null` to clear it.
   */
  setStep(step: AuthStep | null): void;
  /**
   * Mirrors the authentication client's session into the store.
   *
   * @param session - The session, or `null` when signed out.
   * @param reason - Why the session ended by expiry, if it did.
   */
  applySession(session: Session | null, reason: SignOutReason | null): void;
}

/** Authentication store of the console. */
export const useAuthStore = create<AuthState>()((set) => ({
  status: "anonymous",
  role: null,
  step: null,
  userId: null,
  signOutReason: null,
  beginSignIn: () => {
    set({ status: "authenticating" });
  },
  setStep: (step) => {
    set({ step });
  },
  applySession: (session, reason) => {
    if (session === null) {
      set({ status: "anonymous", role: null, step: null, userId: null, signOutReason: reason });
      return;
    }
    set({
      status: "authenticated",
      role: roleFromGroups(session.groups),
      step: null,
      userId: session.userId,
      signOutReason: null,
    });
  },
}));
