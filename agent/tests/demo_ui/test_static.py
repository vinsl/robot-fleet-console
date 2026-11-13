"""Static checks of the page: no inline code, no HTML sinks, no storage, fragment token, strings and
the one-time password of the account form."""

from __future__ import annotations

import re
import shutil
import subprocess
from typing import Final

import pytest

from fleet_agent.demo_ui.server import STATIC_DIR

HTML = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
SCRIPT = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
STYLE = (STATIC_DIR / "app.css").read_text(encoding="utf-8")


def test_the_page_is_three_files() -> None:
    assert sorted(path.name for path in STATIC_DIR.iterdir() if path.is_file()) == [
        "app.css",
        "app.js",
        "index.html",
    ]


def test_html_has_no_inline_script_style_or_event_handler() -> None:
    scripts = re.findall(r"<script\b[^>]*>", HTML)
    assert scripts == ['<script src="/app.js" defer>']
    assert "<style" not in HTML
    assert not re.search(r"\sstyle\s*=", HTML)
    assert not re.search(r"\son[a-z]+\s*=", HTML)


def test_html_loads_only_same_origin_resources() -> None:
    targets = set(re.findall(r'(?:src|href)="([^"]+)"', HTML))
    assert targets == {"/app.css", "/app.js", "#main"}
    assert "http://" not in HTML
    assert "https://" not in HTML


def test_script_writes_no_html_and_keeps_no_storage() -> None:
    for sink in (
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "new Function",
    ):
        assert sink not in SCRIPT, sink
    for storage in ("localStorage", "sessionStorage", "document.cookie"):
        assert storage not in SCRIPT, storage


def test_token_is_read_from_the_fragment_and_scrubbed_from_the_address() -> None:
    assert "window.location.hash" in SCRIPT
    assert "history.replaceState" in SCRIPT
    assert 'headers: { Authorization: "Bearer " + token }' in SCRIPT


def test_no_external_address_in_the_script_or_style() -> None:
    assert not re.search(r"https?://", SCRIPT)
    assert not re.search(r"@import|url\(\s*['\"]?https?", STYLE)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_script_parses() -> None:
    node = shutil.which("node") or "node"
    result = subprocess.run(  # noqa: S603 - fixed arguments, the repository's own file
        [node, "--check", str(STATIC_DIR / "app.js")], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_status_paragraphs_are_polite_live_regions_and_buttons_report_busy() -> None:
    assert HTML.count('aria-live="polite"') == 2
    assert "aria-busy" in SCRIPT
    assert "setButtonsBusy(busyNow)" in SCRIPT


def _locale_keys(locale: str) -> set[str]:
    """Reads the keys of one locale table of the script, a line of `key: "text"` per entry."""
    start = SCRIPT.index(f"    {locale}: {{")
    # The table closes on its own line; a brace inside a text such as {email} does not end it.
    end = start + re.search(r"\n {4}\}", SCRIPT[start:]).start()  # type: ignore[union-attr]
    # Entries sit six spaces deep; the table header sits four.
    return set(re.findall(r"^ {6}(\w+):", SCRIPT[start:end], flags=re.MULTILINE))


EN_KEYS: Final = _locale_keys("en")
FR_KEYS: Final = _locale_keys("fr")


def test_every_data_i18n_key_of_the_page_exists_in_english() -> None:
    keys = set(re.findall(r'data-i18n="([^"]+)"', HTML))

    assert keys
    assert keys - EN_KEYS == set()


def test_english_and_french_have_the_same_keys() -> None:
    assert EN_KEYS == FR_KEYS


def test_every_literal_translation_key_of_the_script_exists_in_english() -> None:
    # A key followed by `+` is built at run time (the phase and connection words): not a literal.
    literal = set(re.findall(r'\bt\("(\w+)"\)', SCRIPT))

    assert literal - EN_KEYS == set()


def test_account_errors_map_only_to_existing_keys() -> None:
    block = SCRIPT[SCRIPT.index("var ACCOUNT_ERRORS = {") :]
    block = block[: block.index("};")]
    targets = set(re.findall(r':\s*"(\w+)"', block))

    assert targets
    assert targets <= EN_KEYS


def test_the_temporary_password_is_a_code_element_and_never_an_input() -> None:
    assert re.search(r'<code id="account-password"', HTML)
    assert not re.search(r"<input[^>]*account-password", HTML)
    assert not re.search(r"<input[^>]*type=\"password\"", HTML)


def test_the_result_panel_is_not_a_live_region_and_takes_focus_on_its_heading() -> None:
    panel = HTML[HTML.index('id="account-result"') :]
    panel = panel[: panel.index("</div>")]

    assert "aria-live" not in panel
    assert 'id="account-result-title" tabindex="-1"' in HTML
    assert '$("account-result-title").focus()' in SCRIPT


def test_the_password_is_cleared_on_hide_on_timer_and_on_pagehide() -> None:
    assert 'window.addEventListener("pagehide", hidePassword)' in SCRIPT
    assert "PASSWORD_VISIBLE_MS = 600000" in SCRIPT
    assert "window.setTimeout(hidePassword, PASSWORD_VISIBLE_MS)" in SCRIPT
    assert 'setText("account-password", "")' in SCRIPT
    assert "shownPassword = null" in SCRIPT


def test_the_password_is_written_as_text_and_never_stored() -> None:
    assert 'setText("account-password", shownPassword)' in SCRIPT
    assert "writeText(shownPassword)" in SCRIPT
    for storage in ("localStorage", "sessionStorage", "document.cookie", "IndexedDB"):
        assert storage not in SCRIPT


def test_the_form_submission_is_cancelled_and_reset_needs_a_confirm_step() -> None:
    assert "event.preventDefault()" in SCRIPT
    assert 'if ($("account-reset").checked)' in SCRIPT
    assert 'event.key === "Escape"' in SCRIPT
    assert 'api("POST", "/api/accounts"' in SCRIPT


def test_a_confirmed_reset_sends_the_confirmed_snapshot_and_an_edit_withdraws_it() -> None:
    # The request body is built from the snapshot, never from the live fields.
    send = SCRIPT[SCRIPT.index("function sendAccount") : SCRIPT.index("function start()")]
    assert "email: account.email" in send
    assert "role: account.role" in send
    assert '$("account-email")' not in send
    assert "pendingAccount = account" in SCRIPT
    assert '$("account-form").addEventListener("input", withdrawConfirm)' in SCRIPT
    assert '$("account-form").addEventListener("change", withdrawConfirm)' in SCRIPT


def test_account_form_fields_follow_the_browser_constraints() -> None:
    email = re.search(r'<input id="account-email"[^>]*>', HTML)
    assert email is not None
    assert 'type="email"' in email.group(0)
    assert 'autocomplete="off"' in email.group(0)
    assert 'maxlength="128"' in email.group(0)
