/**
 * The rules of the password, listed under the new-password field and ticked as the user types. A rule is shown as an
 * icon and as text ("met" or "missing"), never by colour alone (WCAG 1.4.1).
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Circle } from "lucide-react";
import { PASSWORD_MIN_LENGTH, PASSWORD_RULES, type PasswordCheck } from "../auth/password-policy";
import { classNames } from "../lib/class-names";
import styles from "./SignIn.module.css";

/** Props of {@link PasswordRules}. */
export interface PasswordRulesProps {
  /** Identifier the password field points at with `aria-describedby`. */
  readonly id: string;
  /** Which rules hold for the password typed so far. */
  readonly check: PasswordCheck;
}

/**
 * Renders the list of rules.
 *
 * @param props - The element identifier and the check result.
 * @returns The list, with its title.
 */
export function PasswordRules({ id, check }: PasswordRulesProps): React.JSX.Element {
  const { t } = useTranslation("auth");
  return (
    <div id={id} className={styles.rules}>
      <p className={styles.rulesTitle}>{t("newPassword.rulesTitle")}</p>
      <ul className={styles.rulesList}>
        {PASSWORD_RULES.map((rule) => {
          // eslint-disable-next-line security/detect-object-injection -- `rule` is a member of the closed PasswordRule union
          const met = check[rule];
          const Icon = met ? Check : Circle;
          return (
            <li key={rule} className={classNames(styles.rule, met && styles.ruleMet)}>
              <Icon aria-hidden="true" focusable="false" className={styles.ruleIcon} />
              <span>{t(`newPassword.rules.${rule}`, { count: PASSWORD_MIN_LENGTH })}</span>
              <span className={styles.srOnly}>
                {met ? t("newPassword.ruleMet") : t("newPassword.ruleMissing")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
