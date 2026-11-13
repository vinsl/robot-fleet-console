/**
 * The password policy of the console user pool, as the new-password form shows and checks it.
 *
 * The pool enforces the same rules (`infra/modules/identity/main.tf`, `password_policy`): twelve characters, a
 * lowercase letter, an uppercase letter, a digit and a special character. The check here only tells the user what is
 * still missing before the request; the pool stays the authority, and a password that passes here but is refused there
 * gets its own message (`AuthError` kind `password-policy`).
 */

/** Smallest accepted length. Keep equal to `minimum_length` in `infra/modules/identity/main.tf`. */
export const PASSWORD_MIN_LENGTH = 12;

/** The special characters Cognito counts, as in its documentation. A space is not one of them. */
const SPECIAL_CHARACTERS = /[\^$*.[\]{}()?\-"!@#%&/\\,><':;|_~`+=]/;

/** One rule of the policy. */
export type PasswordRule = "length" | "lowercase" | "uppercase" | "number" | "symbol";

/** The rules in display order. */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  "length",
  "lowercase",
  "uppercase",
  "number",
  "symbol",
];

/** Whether each rule holds for a password. */
export type PasswordCheck = Readonly<Record<PasswordRule, boolean>>;

/**
 * Checks a password against every rule.
 *
 * @param password - The password typed by the user.
 * @returns For each rule, whether the password satisfies it.
 */
export function checkPassword(password: string): PasswordCheck {
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    number: /[0-9]/.test(password),
    symbol: SPECIAL_CHARACTERS.test(password),
  };
}

/**
 * Tells whether a password satisfies the whole policy.
 *
 * @param check - The result of {@link checkPassword}.
 * @returns `true` when every rule holds.
 */
export function meetsPolicy(check: PasswordCheck): boolean {
  // eslint-disable-next-line security/detect-object-injection -- `rule` is a member of the closed PasswordRule union
  return PASSWORD_RULES.every((rule) => check[rule]);
}
