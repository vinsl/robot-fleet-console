/**
 * Shown instead of a page the user's role does not allow.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * Explains that the role does not allow the page. It names no role and no rule, so nothing about the access
 * model is disclosed.
 *
 * @returns The forbidden message.
 */
export function Forbidden(): React.JSX.Element {
  const { t } = useTranslation("shell");
  return (
    <section aria-labelledby="forbidden-title">
      <h1 id="forbidden-title">{t("forbidden.title")}</h1>
      <p>{t("forbidden.body")}</p>
    </section>
  );
}
