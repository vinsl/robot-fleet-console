/**
 * Shown when the console cannot start, for example when the runtime configuration is missing or invalid.
 *
 * The page carries no detail about the cause: the reason is a deployment problem, not something the user can act on.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * Renders the fixed start-up failure message.
 *
 * @returns The failure message.
 */
export function BootFailure(): React.JSX.Element {
  const { t } = useTranslation("common");
  return (
    <section aria-labelledby="boot-failure-title">
      <h1 id="boot-failure-title">{t("app.name")}</h1>
      <p role="alert">{t("app.bootFailed")}</p>
    </section>
  );
}
