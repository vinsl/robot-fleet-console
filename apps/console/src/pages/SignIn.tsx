/**
 * Sign-in page. It is a centred glass card over a blurred map, and it shows one form per step of the
 * sequence the authentication client reports:
 *
 * - credentials, then (first login) a new password and the TOTP enrolment, or (later logins) the TOTP code;
 * - the step lives in the authentication store, so a reload starts again from the credentials (tokens are
 *   never persisted, SEC-WEB-2).
 *
 * Every error is shown as a fixed message in an alert region. The page never shows the Cognito text.
 */
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { useServices } from "../app/services";
import { useAuthStore } from "../auth/auth-store";
import { AuthError, type AuthErrorKind, type AuthStep } from "../auth/cognito-client";
import { checkPassword, meetsPolicy } from "../auth/password-policy";
import { TotpQrCode } from "../components/TotpQrCode";
import { PlaceholderPlane } from "../fleet/map/PlaceholderPlane";
import { PasswordRules } from "./PasswordRules";
import styles from "./SignIn.module.css";
import { classNames } from "../lib/class-names";

/** Translation key of the message for each failure category. */
const ERROR_KEYS: Readonly<Record<AuthErrorKind, string>> = {
  invalid: "errors.invalid",
  code: "errors.code",
  locked: "errors.locked",
  network: "errors.network",
  generic: "errors.generic",
  expired: "sessionExpired",
  "password-policy": "errors.passwordPolicy",
};

/**
 * A TOTP code is six digits. Checked before the request so that a typo costs no Cognito call. The code forms
 * use `noValidate`: the check is ours, so the message is translated like every other error.
 */
const CODE_PATTERN = /^[0-9]{6}$/;

/**
 * Chooses the message for a failed step.
 *
 * @param error - The value the step rejected with.
 * @returns The translation key.
 */
function errorKeyOf(error: unknown): string {
  return error instanceof AuthError ? ERROR_KEYS[error.kind] : ERROR_KEYS.generic;
}

/**
 * Shared state of a step form: busy flag, the error message key, and the runner that keeps them in sync with
 * the next step the client reports.
 *
 * @returns The busy flag, the error key, a setter for local errors, and the runner.
 */
function useStepAction(): {
  readonly busy: boolean;
  readonly errorKey: string | null;
  readonly fail: (key: string) => void;
  readonly perform: (action: () => Promise<AuthStep>) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  return {
    busy,
    errorKey,
    fail: setErrorKey,
    perform: async (action) => {
      setBusy(true);
      setErrorKey(null);
      try {
        const next = await action();
        // A successful sign-in clears the step through the session listener; nothing else to do here.
        useAuthStore.getState().setStep(next.kind === "signed-in" ? null : next);
      } catch (error) {
        setErrorKey(errorKeyOf(error));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** The error message, rendered only when there is one, in an alert region. */
function ErrorMessage({
  errorKey,
}: {
  readonly errorKey: string | null;
}): React.JSX.Element | null {
  const { t } = useTranslation("auth");
  if (errorKey === null) {
    return null;
  }
  return (
    <p role="alert" className={styles.error}>
      {t(errorKey)}
    </p>
  );
}

/**
 * First step: email and password.
 *
 * @returns The form.
 */
function CredentialsForm(): React.JSX.Element {
  const { t } = useTranslation("auth");
  const { auth } = useServices();
  const { busy, errorKey, perform } = useStepAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const emailId = useId();
  const passwordId = useId();

  return (
    <>
      <h1 className={styles.title}>{t("signIn.title")}</h1>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void perform(() => auth.signIn(email, password));
        }}
      >
        <label className={styles.label} htmlFor={emailId}>
          {t("signIn.email")}
        </label>
        <input
          id={emailId}
          className={styles.input}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <label className={styles.label} htmlFor={passwordId}>
          {t("signIn.password")}
        </label>
        <input
          id={passwordId}
          className={styles.input}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <button type="submit" className={styles.button} disabled={busy}>
          {t("signIn.submit")}
        </button>
      </form>
      <ErrorMessage errorKey={errorKey} />
    </>
  );
}

/**
 * First login: the password the administrator created is replaced by one the user chooses.
 *
 * @returns The form.
 */
function NewPasswordForm(): React.JSX.Element {
  const { t } = useTranslation("auth");
  const { auth } = useServices();
  const { busy, errorKey, fail, perform } = useStepAction();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const passwordId = useId();
  const rulesId = useId();
  const confirmationId = useId();
  const check = checkPassword(password);

  return (
    <>
      <h1 className={styles.title}>{t("newPassword.title")}</h1>
      <p className={styles.body}>{t("newPassword.body")}</p>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!meetsPolicy(check)) {
            fail("form.passwordWeak");
            return;
          }
          // Both values are typed by the same user in this form; this is not a secret comparison.
          // eslint-disable-next-line security/detect-possible-timing-attacks -- client-side equality of two typed values
          if (password !== confirmation) {
            fail("form.passwordMismatch");
            return;
          }
          void perform(() => auth.completeNewPassword(password));
        }}
      >
        <label className={styles.label} htmlFor={passwordId}>
          {t("newPassword.password")}
        </label>
        <input
          id={passwordId}
          className={styles.input}
          type="password"
          autoComplete="new-password"
          required
          aria-describedby={rulesId}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        <PasswordRules id={rulesId} check={check} />
        <label className={styles.label} htmlFor={confirmationId}>
          {t("newPassword.confirm")}
        </label>
        <input
          id={confirmationId}
          className={styles.input}
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value);
          }}
        />
        <button type="submit" className={styles.button} disabled={busy}>
          {t("newPassword.submit")}
        </button>
      </form>
      <ErrorMessage errorKey={errorKey} />
    </>
  );
}

/** Props of {@link TotpSetupForm}. */
interface TotpSetupFormProps {
  /** Base32 secret, shown as text for users who cannot scan the code. */
  readonly secretCode: string;
  /** The `otpauth://` URI encoded in the QR code. */
  readonly otpauthUri: string;
}

/**
 * First login: the authenticator app is enrolled by scanning the QR code, then confirmed with a code.
 *
 * @param props - The enrolment secret and URI.
 * @returns The form.
 */
function TotpSetupForm({ secretCode, otpauthUri }: TotpSetupFormProps): React.JSX.Element {
  const { t } = useTranslation("auth");
  const { auth } = useServices();
  const { busy, errorKey, fail, perform } = useStepAction();
  const [code, setCode] = useState("");
  const codeId = useId();
  const secretId = useId();

  return (
    <>
      <h1 className={styles.title}>{t("totpSetup.title")}</h1>
      <p className={styles.body}>{t("totpSetup.body")}</p>
      <TotpQrCode uri={otpauthUri} />
      <label className={styles.label} htmlFor={secretId}>
        {t("totpSetup.secretLabel")}
      </label>
      <input
        id={secretId}
        className={styles.secret}
        type="text"
        readOnly
        autoComplete="off"
        spellCheck={false}
        value={secretCode}
      />
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!CODE_PATTERN.test(code)) {
            fail("form.invalidCode");
            return;
          }
          void perform(() => auth.verifyTotpSetup(code));
        }}
      >
        <label className={styles.label} htmlFor={codeId}>
          {t("totpSetup.code")}
        </label>
        <TotpCodeInput id={codeId} value={code} onChange={setCode} />
        <button type="submit" className={styles.button} disabled={busy}>
          {t("totpSetup.submit")}
        </button>
      </form>
      <ErrorMessage errorKey={errorKey} />
    </>
  );
}

/**
 * Later logins: the TOTP code of the enrolled device.
 *
 * @returns The form.
 */
function TotpCodeForm(): React.JSX.Element {
  const { t } = useTranslation("auth");
  const { auth } = useServices();
  const { busy, errorKey, fail, perform } = useStepAction();
  const [code, setCode] = useState("");
  const codeId = useId();

  return (
    <>
      <h1 className={styles.title}>{t("totp.title")}</h1>
      <p className={styles.body}>{t("totp.body")}</p>
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!CODE_PATTERN.test(code)) {
            fail("form.invalidCode");
            return;
          }
          void perform(() => auth.submitTotp(code));
        }}
      >
        <label className={styles.label} htmlFor={codeId}>
          {t("totp.code")}
        </label>
        <TotpCodeInput id={codeId} value={code} onChange={setCode} />
        <button type="submit" className={styles.button} disabled={busy}>
          {t("totp.submit")}
        </button>
      </form>
      <ErrorMessage errorKey={errorKey} />
    </>
  );
}

/** Props of {@link TotpCodeInput}. */
interface TotpCodeInputProps {
  /** Id of the input, matched by the label. */
  readonly id: string;
  /** Current code. */
  readonly value: string;
  /** Receives the code as typed. */
  readonly onChange: (value: string) => void;
}

/**
 * The six-digit input shared by the two TOTP steps. The attributes let phones show the digit keypad and let
 * password managers fill the one-time code.
 *
 * @param props - Id, value and change handler.
 * @returns The input.
 */
function TotpCodeInput({ id, value, onChange }: TotpCodeInputProps): React.JSX.Element {
  return (
    <input
      id={id}
      className={styles.input}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

/**
 * Renders the form that matches the current authentication step.
 *
 * @param props - The step, or `null` before the first attempt.
 * @returns The form.
 */
function StepForm({ step }: { readonly step: AuthStep | null }): React.JSX.Element {
  if (step === null || step.kind === "signed-in") {
    return <CredentialsForm />;
  }
  switch (step.kind) {
    case "new-password":
      return <NewPasswordForm />;
    case "totp-setup":
      return <TotpSetupForm secretCode={step.secretCode} otpauthUri={step.otpauthUri} />;
    case "totp-required":
      return <TotpCodeForm />;
  }
}

/**
 * The sign-in page. Redirects to the fleet view once the user is signed in.
 *
 * @returns The page.
 */
export function SignIn(): React.JSX.Element {
  const { t } = useTranslation("auth");
  const status = useAuthStore((state) => state.status);
  const step = useAuthStore((state) => state.step);
  const signOutReason = useAuthStore((state) => state.signOutReason);

  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }

  return (
    <main className={styles.page}>
      <div className={styles.backdrop}>
        <PlaceholderPlane />
      </div>
      <section className={classNames("glass", styles.card)}>
        {signOutReason === "expired" ? (
          <p role="status" className={styles.body}>
            {t("sessionExpired")}
          </p>
        ) : null}
        <StepForm step={step} />
      </section>
    </main>
  );
}
