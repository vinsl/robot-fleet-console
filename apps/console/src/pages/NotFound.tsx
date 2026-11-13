/**
 * Shown for any address that matches no route of the console.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * Renders the not-found message.
 *
 * @returns The not-found message.
 */
export function NotFound(): React.JSX.Element {
  const { t } = useTranslation("shell");
  return (
    <section aria-labelledby="not-found-title">
      <h1 id="not-found-title">{t("notFound.title")}</h1>
      <p>{t("notFound.body")}</p>
    </section>
  );
}
