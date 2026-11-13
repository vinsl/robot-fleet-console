/**
 * In-memory key-value store handed to the Cognito library in place of `localStorage`.
 *
 * The library persists tokens through the storage it is given, and defaults to `localStorage`. Tokens there
 * survive a reload and can be read by any script on the page, so the console gives the library this shim
 * instead (ADR 0045). A reload therefore signs the user out, which is the intended behaviour (SEC-WEB-2).
 */

/**
 * Storage that lives only as long as the page: nothing is written to disk or to the browser storage.
 * Its shape matches the storage contract of the Cognito library, which accepts it structurally.
 */
export class MemoryStorage {
  readonly #items = new Map<string, string>();

  /**
   * Stores a value under a key.
   *
   * @param key - Storage key chosen by the library.
   * @param value - Value to keep until the page unloads.
   */
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  /**
   * Reads a value.
   *
   * @param key - Storage key.
   * @returns The stored value, or `null` when the key is absent.
   */
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  /**
   * Removes one key. Removing an absent key is a no-op.
   *
   * @param key - Storage key.
   */
  removeItem(key: string): void {
    this.#items.delete(key);
  }

  /** Removes every key. */
  clear(): void {
    this.#items.clear();
  }
}
