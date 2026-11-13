/**
 * Translations of the video page: English and French, with the English text as the fallback.
 *
 * The page reads its language once, from the browser, and sets `lang` on the document so that
 * assistive technology pronounces the text correctly. Every visible string goes through {@link t}.
 */
import en from "./en.json";
import fr from "./fr.json";

/** A message key. The English file is the reference: French must have the same keys (tested). */
export type MessageKey = keyof typeof en;

/** Values substituted for the `{{name}}` placeholders of a message. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** Languages the page can show. */
export type Locale = "en" | "fr";

/** The message tables by language. A map, so that a lookup never indexes an object with a variable. */
const MESSAGES: ReadonlyMap<Locale, ReadonlyMap<string, string>> = new Map<
  Locale,
  ReadonlyMap<string, string>
>([
  ["en", new Map(Object.entries(en))],
  ["fr", new Map(Object.entries(fr))],
]);

/** Language in use. English until {@link applyLocale} runs. */
let activeLocale: Locale = "en";

/**
 * Chooses the language for a browser language tag.
 *
 * @param language - A BCP 47 tag, for example `fr-FR` or `en-US`.
 * @returns `fr` for any French tag, `en` for everything else.
 */
export function localeFor(language: string): Locale {
  return language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/**
 * Tells whether a string names a message, so that a key read from the HTML can be checked.
 *
 * @param value - Any string, for example a `data-i18n` attribute.
 * @returns True when the string is a key of the English file.
 */
export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(en, value);
}

/**
 * Returns the text of a message in a language. An unknown language falls back to English.
 *
 * @param locale - The language. Any string is accepted; unknown values use English.
 * @param key - The message key.
 * @param params - Values for the `{{name}}` placeholders.
 * @returns The message with its placeholders replaced.
 */
export function translate(locale: string, key: MessageKey, params: MessageParams = {}): string {
  const table = MESSAGES.get(locale === "fr" ? "fr" : "en");
  // The key type comes from the English file, so the lookup is always defined; the fallback only
  // satisfies the type checker.
  const template = table?.get(key) ?? MESSAGES.get("en")?.get(key) ?? key;
  const values = new Map(Object.entries(params));
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(values.get(name) ?? ""),
  );
}

/**
 * Returns the text of a message in the language of the page.
 *
 * @param key - The message key.
 * @param params - Values for the `{{name}}` placeholders.
 * @returns The translated text.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(activeLocale, key, params);
}

/**
 * Sets the language of the page from a browser language tag, and the `lang` attribute of the
 * document.
 *
 * @param language - The browser language, for example `navigator.language`.
 */
export function applyLocale(language: string): void {
  activeLocale = localeFor(language);
  document.documentElement.lang = activeLocale;
}
