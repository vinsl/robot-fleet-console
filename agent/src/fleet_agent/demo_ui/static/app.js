// Local demo control page. Plain script, no framework and no inline code: the CSP allows only 'self'.
// The token arrives in the URL fragment, which the browser never sends; it is kept in memory and the
// address bar is cleaned. All text is written with textContent, never with HTML built from server data.
(function () {
  "use strict";

  var STRINGS = {
    en: {
      title: "Fleet Console demo control",
      skip: "Skip to content",
      siteLabel: "Site",
      readOnly: "(read only)",
      controlTitle: "Simulated fleet",
      stateLabel: "State",
      consumerLabel: "Live data",
      consumerEnabled: "enabled",
      consumerDisabled: "disabled",
      consumerUnknown: "unknown",
      autoStop: "auto-stop at {time}",
      start: "Start",
      countLabel: "Simulated robots",
      countInvalid: "Enter a number of robots from 1 to {max}.",
      stop: "Stop",
      consoleLabel: "Console address",
      copy: "Copy",
      copied: "Copied to the clipboard.",
      copyFailed: "Copy failed: select the address and copy it by hand.",
      share: "Share",
      realTitle: "Real robot",
      realHint: "Start it on the Kali VM with make agent ROBOT=<robot-id>.",
      noRealRobot: "No real robot is registered on this site.",
      robotsTitle: "Robots",
      refresh: "Refresh",
      robotsCaption: "Robots of the site",
      colId: "Identifier",
      colName: "Name",
      colKind: "Kind",
      colRegistry: "Registry",
      colConnection: "Connection",
      colLastSeen: "Last seen",
      kindSimulated: "SIM simulated",
      kindReal: "REAL real",
      connectionOnline: "online",
      connectionOffline: "offline",
      connectionUnknown: "unknown",
      usersTitle: "Operator accounts",
      usersCaption: "Accounts of the user pool",
      colUser: "User",
      colRole: "Role",
      colStatus: "Status",
      colEnabled: "Enabled",
      enabledYes: "yes",
      enabledNo: "no",
      roleNone: "no role",
      phaseStopped: "stopped",
      phaseStarting: "starting",
      phaseRunning: "running",
      phaseStopping: "stopping",
      phaseError: "error",
      stepLabel: "step {step}",
      noSession: "The AWS session has expired or is missing. Run aws sso login in a terminal, then retry.",
      requestFailed: "The request failed. Retry in a moment.",
      busy: "Another change is already running.",
      tokenMissing: "No access token: open the page from the link printed by make demo-ui.",
      accountTitle: "Create or reset an account",
      accountEmail: "E-mail",
      accountRole: "Role",
      roleOperator: "Operator",
      roleViewer: "Viewer",
      accountReset: "Reset an existing account",
      accountResetHint: "The account keeps its role. Its current password stops working and it gets a new temporary password.",
      accountSubmit: "Create account",
      accountResetSubmit: "Reset password",
      accountConfirm: "Reset the password of {email}? Its current password stops working at once.",
      accountConfirmYes: "Confirm reset",
      accountCancel: "Cancel",
      accountCreated: "Account created",
      accountResetDone: "New temporary password issued",
      accountPasswordNote: "Shown once and stored nowhere. The user must change it at the first sign-in; it expires after one day.",
      accountCopy: "Copy",
      accountCopied: "Password copied to the clipboard.",
      accountCopyFailed: "Copy failed: select the password and copy it by hand.",
      accountHide: "Hide",
      errUserExists: "An account with this e-mail already exists. Reset it instead.",
      errUserNotFound: "No account with this e-mail exists in the pool.",
      errRoleMismatch: "The account has another role. Pick the role it already has to reset it.",
      errProtected: "This account cannot be reset from this page.",
      errRateLimited: "Too many account changes in the last ten minutes. Wait a few minutes.",
      errInvalidEmail: "The e-mail address is not valid.",
      errInvalidRole: "The role must be Operator or Viewer.",
      errPartial: "The account change stopped half way. Run make bootstrap-admin with RESET=1 in a terminal.",
      errTimeout: "The account change did not finish in time. Check the user list before retrying.",
      errPoolTooLarge: "The pool has too many accounts for this page to check. Run make bootstrap-admin in a terminal.",
      errAccountFailed: "The account could not be changed. The local log has the details."
    },
    fr: {
      title: "Pilotage de la démo Fleet Console",
      skip: "Aller au contenu",
      siteLabel: "Site",
      readOnly: "(lecture seule)",
      controlTitle: "Flotte simulée",
      stateLabel: "État",
      consumerLabel: "Données en direct",
      consumerEnabled: "activées",
      consumerDisabled: "désactivées",
      consumerUnknown: "inconnu",
      autoStop: "arrêt automatique à {time}",
      start: "Démarrer",
      countLabel: "Robots simulés",
      countInvalid: "Saisissez un nombre de robots de 1 à {max}.",
      stop: "Arrêter",
      consoleLabel: "Adresse de la console",
      copy: "Copier",
      copied: "Copié dans le presse-papiers.",
      copyFailed: "Copie impossible : sélectionnez l'adresse et copiez-la à la main.",
      share: "Partager",
      realTitle: "Robot réel",
      realHint: "Démarrez-le sur la VM Kali avec make agent ROBOT=<robot-id>.",
      noRealRobot: "Aucun robot réel n'est enregistré sur ce site.",
      robotsTitle: "Robots",
      refresh: "Actualiser",
      robotsCaption: "Robots du site",
      colId: "Identifiant",
      colName: "Nom",
      colKind: "Type",
      colRegistry: "Registre",
      colConnection: "Connexion",
      colLastSeen: "Vu pour la dernière fois",
      kindSimulated: "SIM simulé",
      kindReal: "REEL réel",
      connectionOnline: "en ligne",
      connectionOffline: "hors ligne",
      connectionUnknown: "inconnu",
      usersTitle: "Comptes opérateurs",
      usersCaption: "Comptes du pool d'utilisateurs",
      colUser: "Utilisateur",
      colRole: "Rôle",
      colStatus: "Statut",
      colEnabled: "Activé",
      enabledYes: "oui",
      enabledNo: "non",
      roleNone: "aucun rôle",
      phaseStopped: "arrêté",
      phaseStarting: "démarrage",
      phaseRunning: "en marche",
      phaseStopping: "arrêt en cours",
      phaseError: "erreur",
      stepLabel: "étape {step}",
      noSession: "La session AWS a expiré ou manque. Lancez aws sso login dans un terminal, puis réessayez.",
      requestFailed: "La requête a échoué. Réessayez dans un instant.",
      busy: "Une autre opération est déjà en cours.",
      tokenMissing: "Jeton d'accès absent : ouvrez la page avec le lien affiché par make demo-ui.",
      accountTitle: "Créer ou réinitialiser un compte",
      accountEmail: "Adresse e-mail",
      accountRole: "Rôle",
      roleOperator: "Opérateur",
      roleViewer: "Observateur",
      accountReset: "Réinitialiser un compte existant",
      accountResetHint: "Le compte garde son rôle. Son mot de passe actuel cesse de fonctionner et il reçoit un mot de passe temporaire.",
      accountSubmit: "Créer le compte",
      accountResetSubmit: "Réinitialiser le mot de passe",
      accountConfirm: "Réinitialiser le mot de passe de {email} ? Le mot de passe actuel cesse de fonctionner immédiatement.",
      accountConfirmYes: "Confirmer la réinitialisation",
      accountCancel: "Annuler",
      accountCreated: "Compte créé",
      accountResetDone: "Nouveau mot de passe temporaire émis",
      accountPasswordNote: "Affiché une seule fois, et enregistré nulle part. L'utilisateur doit le changer à sa première connexion ; il expire au bout d'un jour.",
      accountCopy: "Copier",
      accountCopied: "Mot de passe copié dans le presse-papiers.",
      accountCopyFailed: "Copie impossible : sélectionnez le mot de passe et copiez-le à la main.",
      accountHide: "Masquer",
      errUserExists: "Un compte avec cette adresse existe déjà. Réinitialisez-le à la place.",
      errUserNotFound: "Aucun compte avec cette adresse n'existe dans le pool.",
      errRoleMismatch: "Le compte a un autre rôle. Choisissez le rôle qu'il a déjà pour le réinitialiser.",
      errProtected: "Ce compte ne peut pas être réinitialisé depuis cette page.",
      errRateLimited: "Trop de modifications de comptes ces dix dernières minutes. Patientez quelques minutes.",
      errInvalidEmail: "L'adresse e-mail n'est pas valide.",
      errInvalidRole: "Le rôle doit être Opérateur ou Observateur.",
      errPartial: "La modification du compte s'est arrêtée à mi-chemin. Lancez make bootstrap-admin avec RESET=1 dans un terminal.",
      errTimeout: "La modification du compte n'a pas abouti à temps. Vérifiez la liste des utilisateurs avant de réessayer.",
      errPoolTooLarge: "Le pool compte trop de comptes pour être vérifié depuis cette page. Lancez make bootstrap-admin dans un terminal.",
      errAccountFailed: "Le compte n'a pas pu être modifié. Le journal local contient les détails."
    }
  };

  // Account errors have a translated text; the other codes fall back to the server's fixed text.
  var ACCOUNT_ERRORS = {
    USER_EXISTS: "errUserExists",
    USER_NOT_FOUND: "errUserNotFound",
    ROLE_MISMATCH: "errRoleMismatch",
    ACCOUNT_PROTECTED: "errProtected",
    RATE_LIMITED: "errRateLimited",
    INVALID_EMAIL: "errInvalidEmail",
    INVALID_ROLE: "errInvalidRole",
    POOL_TOO_LARGE: "errPoolTooLarge",
    ACCOUNT_FAILED: "errAccountFailed",
    ACCOUNT_PARTIAL: "errPartial",
    ACCOUNT_TIMEOUT: "errTimeout"
  };

  // Same symbol and text for every state, so that no state is shown by colour alone.
  var PHASE_SYMBOL = { stopped: "○", starting: "◐", running: "●", stopping: "◐", error: "▲" };
  var CONNECTION_SYMBOL = { online: "●", offline: "○", unknown: "?" };
  var POLL_BUSY_MS = 3000;
  var POLL_IDLE_MS = 15000;
  // The temporary password stays on screen for ten minutes at most, then it is cleared.
  var PASSWORD_VISIBLE_MS = 600000;

  var lang = /^fr\b/i.test(navigator.language || "") ? "fr" : "en";
  var token = "";
  var site = "";
  var pollTimer = null;
  var busy = false;
  var lastPhase = "";
  // The temporary password of the last answer, kept in memory only and cleared by hidePassword.
  var shownPassword = null;
  var hideTimer = null;
  var accountBusy = false;

  function t(key, vars) {
    var table = STRINGS[lang];
    var text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : STRINGS.en[key];
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.replace("{" + name + "}", String(vars[name]));
      });
    }
    return text;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    $(id).textContent = text;
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function takeToken() {
    var match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash);
    if (match) {
      try {
        token = decodeURIComponent(match[1]);
      } catch (error) {
        token = "";
      }
    }
    // The token must not stay in the address bar, the history or a screenshot of the URL.
    window.history.replaceState(null, "", window.location.pathname);
  }

  function ApiError(status, problem) {
    this.status = status;
    this.code = problem && typeof problem.code === "string" ? problem.code : "";
    this.detail = problem && typeof problem.detail === "string" ? problem.detail : "";
  }

  function api(method, path, body) {
    var init = {
      method: method,
      headers: { Authorization: "Bearer " + token },
      cache: "no-store",
      credentials: "omit"
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () {
        return null;
      }).then(function (data) {
        if (!response.ok) {
          throw new ApiError(response.status, data);
        }
        return data;
      });
    });
  }

  function showError(message) {
    var box = $("error");
    box.textContent = message;
    box.hidden = !message;
  }

  function showInfo(message) {
    var box = $("info");
    box.textContent = message;
    box.hidden = !message;
  }

  function describeError(failure) {
    if (failure instanceof ApiError && failure.code === "NO_SESSION") {
      return t("noSession");
    }
    if (failure instanceof ApiError && Object.prototype.hasOwnProperty.call(ACCOUNT_ERRORS, failure.code)) {
      return t(ACCOUNT_ERRORS[failure.code]);
    }
    if (failure instanceof ApiError && failure.detail) {
      return failure.detail;
    }
    return t("requestFailed");
  }

  // Buttons announce a running start or stop through aria-busy; the disabled state still blocks clicks.
  function setButtonsBusy(flag) {
    $("start-button").setAttribute("aria-busy", flag ? "true" : "false");
    $("stop-button").setAttribute("aria-busy", flag ? "true" : "false");
  }

  function renderStatus(status) {
    var phase = status.phase;
    lastPhase = phase;
    var chip = $("phase");
    chip.textContent = PHASE_SYMBOL[phase] + " " + t("phase" + capitalise(phase));
    setText("step", status.step ? t("stepLabel", { step: status.step }) : "");
    setText("consumer", consumerLabel(status.consumer));
    var autoStop = $("auto-stop");
    autoStop.textContent =
      status.autoStopAt && status.simulatorsRunning
        ? " · " + t("autoStop", { time: status.autoStopAt })
        : "";
    var busyNow = phase === "starting" || phase === "stopping";
    $("start-button").disabled = busyNow;
    // A running fleet keeps its size: the count can change only while the simulators are stopped.
    $("count-input").disabled = busyNow || status.simulatorsRunning === true;
    if (status.simulatorsRunning === true && typeof status.simCount === "number") {
      $("count-input").value = String(status.simCount);
    }
    $("stop-button").disabled = busyNow;
    setButtonsBusy(busyNow);
    var consoleBox = $("console");
    consoleBox.hidden = !status.consoleUrl || phase !== "running";
    if (status.consoleUrl) {
      $("console-url").value = status.consoleUrl;
    }
    renderRealRobots(status.realRobots || []);
    if (status.error) {
      showError(status.error.code === "NO_SESSION" ? t("noSession") : status.error.message);
    } else {
      showError("");
    }
  }

  function capitalise(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function consumerLabel(state) {
    if (state === "Enabled") {
      return t("consumerEnabled");
    }
    if (state === "Disabled") {
      return t("consumerDisabled");
    }
    return t("consumerUnknown");
  }

  function renderRealRobots(robots) {
    var list = $("real-robots");
    list.textContent = "";
    if (robots.length === 0) {
      list.appendChild(element("li", "", t("noRealRobot")));
      return;
    }
    robots.forEach(function (robot) {
      var item = element("li", "");
      item.appendChild(element("strong", "", robot.robotId + " "));
      item.appendChild(element("span", "badge badge-real", t("kindReal")));
      item.appendChild(document.createTextNode(" " + connectionText(robot.connection)));
      list.appendChild(item);
    });
  }

  function connectionText(connection) {
    var key = connection === "online" || connection === "offline" ? connection : "unknown";
    return CONNECTION_SYMBOL[key] + " " + t("connection" + capitalise(key));
  }

  function refreshStatus() {
    return api("GET", "/api/status?site=" + encodeURIComponent(site))
      .then(function (status) {
        renderStatus(status);
        schedulePoll(status.phase === "starting" || status.phase === "stopping");
      })
      .catch(function (failure) {
        showError(describeError(failure));
        schedulePoll(false);
      });
  }

  function schedulePoll(fast) {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
    }
    pollTimer = window.setTimeout(refreshStatus, fast ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  // The largest fleet the server accepts, set from /api/config; the server validates the number again.
  var maxSimCount = 20;

  /** Reads the number of robots to start, or null when the field is not a whole number in range. */
  function readCount() {
    var text = $("count-input").value.trim();
    if (!/^[0-9]{1,2}$/.test(text)) {
      return null;
    }
    var count = Number(text);
    return count >= 1 && count <= maxSimCount ? count : null;
  }

  function runAction(path, withCount) {
    if (busy) {
      return;
    }
    var body = { site: site };
    if (withCount) {
      var count = readCount();
      if (count === null) {
        showError(t("countInvalid").replace("{max}", String(maxSimCount)));
        return;
      }
      body.count = count;
    }
    busy = true;
    setButtonsBusy(true);
    showInfo("");
    api("POST", path, body)
      .then(function (status) {
        renderStatus(status);
        schedulePoll(true);
      })
      .catch(function (failure) {
        if (failure instanceof ApiError && failure.status === 409) {
          showInfo(t("busy"));
          return;
        }
        showError(describeError(failure));
      })
      .then(function () {
        busy = false;
        setButtonsBusy(lastPhase === "starting" || lastPhase === "stopping");
      });
  }

  function renderRobots(robots) {
    var body = $("robots-body");
    body.textContent = "";
    robots.forEach(function (robot) {
      var row = element("tr", "");
      row.appendChild(element("th", "", robot.robotId));
      row.appendChild(element("td", "", robot.name));
      var kind = element("td", "");
      kind.appendChild(
        element(
          "span",
          "badge " + (robot.kind === "real" ? "badge-real" : "badge-simulated"),
          robot.kind === "real" ? t("kindReal") : t("kindSimulated")
        )
      );
      row.appendChild(kind);
      row.appendChild(element("td", "", robot.registryStatus));
      row.appendChild(element("td", "", connectionText(robot.connection)));
      row.appendChild(element("td", "", robot.lastSeen || "-"));
      body.appendChild(row);
    });
  }

  function renderUsers(users) {
    var body = $("users-body");
    body.textContent = "";
    users.forEach(function (user) {
      var row = element("tr", "");
      row.appendChild(element("th", "", user.displayName));
      row.appendChild(element("td", "", user.role === "none" ? t("roleNone") : user.role));
      row.appendChild(element("td", "", user.status));
      row.appendChild(element("td", "", user.enabled ? t("enabledYes") : t("enabledNo")));
      body.appendChild(row);
    });
  }

  function refreshLists() {
    api("GET", "/api/robots?site=" + encodeURIComponent(site))
      .then(function (data) {
        renderRobots(data.robots || []);
      })
      .catch(function (failure) {
        showError(describeError(failure));
      });
    api("GET", "/api/users")
      .then(function (data) {
        renderUsers(data.users || []);
      })
      .catch(function (failure) {
        showError(describeError(failure));
      });
  }

  function copyAddress() {
    var address = $("console-url").value;
    var done = function () {
      setText("copy-status", t("copied"));
    };
    var failed = function () {
      setText("copy-status", t("copyFailed"));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(address).then(done, failed);
      return;
    }
    var field = $("console-url");
    field.select();
    // Fallback for browsers without the asynchronous clipboard API.
    if (document.execCommand && document.execCommand("copy")) {
      done();
    } else {
      failed();
    }
  }

  function shareAddress() {
    navigator.share({ url: $("console-url").value }).catch(function () {
      return undefined;
    });
  }

  function translate() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      if (key && STRINGS[lang][key] !== undefined) {
        node.textContent = STRINGS[lang][key];
      }
    });
    if (!navigator.share) {
      $("share-button").hidden = true;
    } else {
      $("share-button").hidden = false;
    }
  }

  // Shows the temporary password once, as text in a code element. The panel takes focus on its
  // heading, not through a live region, so the password is never announced twice.
  function showPassword(result) {
    if (typeof result.temporaryPassword !== "string") {
      throw new Error("the account answer has no password");
    }
    shownPassword = result.temporaryPassword;
    setText("account-result-title", t(result.outcome === "reset" ? "accountResetDone" : "accountCreated"));
    setText("account-password", shownPassword);
    setText("account-copy-status", "");
    $("account-result").hidden = false;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hidePassword, PASSWORD_VISIBLE_MS);
    $("account-result-title").focus();
  }

  // Clears the password from the page and from memory. Called by the Hide button, by the timer and
  // when the page is left, so the password never outlives its panel.
  function hidePassword() {
    window.clearTimeout(hideTimer);
    hideTimer = null;
    shownPassword = null;
    setText("account-password", "");
    setText("account-copy-status", "");
    $("account-result").hidden = true;
  }

  function copyPassword() {
    if (shownPassword === null) {
      return;
    }
    var done = function () {
      setText("account-copy-status", t("accountCopied"));
    };
    var failed = function () {
      setText("account-copy-status", t("accountCopyFailed"));
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shownPassword).then(done, failed);
      return;
    }
    failed();
  }

  function updateSubmitLabel() {
    setText("account-submit", t($("account-reset").checked ? "accountResetSubmit" : "accountSubmit"));
  }

  function setAccountBusy(flag) {
    $("account-submit").disabled = flag;
    $("account-submit").setAttribute("aria-busy", flag ? "true" : "false");
  }

  // The account the confirm step names. A reset sends exactly this snapshot, never the live fields, so editing the form
  // while the panel is open cannot reset a different account than the one the operator confirmed.
  var pendingAccount = null;

  function readAccount() {
    return { email: $("account-email").value, role: $("account-role").value };
  }

  // A reset invalidates the account's current password, so it needs a second, explicit step.
  function submitAccount(event) {
    // The page's CSP forbids form submission (form-action 'none'): the form never leaves the page.
    event.preventDefault();
    if (accountBusy) {
      return;
    }
    var account = readAccount();
    if ($("account-reset").checked) {
      pendingAccount = account;
      setText("account-confirm-text", t("accountConfirm", { email: account.email }));
      $("account-confirm").hidden = false;
      $("account-confirm-yes").focus();
      return;
    }
    sendAccount(false, account);
  }

  function confirmReset() {
    var account = pendingAccount;
    pendingAccount = null;
    $("account-confirm").hidden = true;
    $("account-submit").focus();
    if (account !== null) {
      sendAccount(true, account);
    }
  }

  function cancelConfirm() {
    pendingAccount = null;
    $("account-confirm").hidden = true;
    $("account-submit").focus();
  }

  // Any edit of the form withdraws a pending confirmation: it was given for the values that were on screen.
  function withdrawConfirm() {
    if (!$("account-confirm").hidden) {
      pendingAccount = null;
      $("account-confirm").hidden = true;
    }
  }

  function sendAccount(reset, account) {
    accountBusy = true;
    setAccountBusy(true);
    showInfo("");
    api("POST", "/api/accounts", {
      email: account.email,
      role: account.role,
      reset: reset
    })
      .then(function (result) {
        showPassword(result);
        $("account-form").reset();
        updateSubmitLabel();
        refreshLists();
      })
      .catch(function (failure) {
        showError(describeError(failure));
      })
      .then(function () {
        accountBusy = false;
        setAccountBusy(false);
      });
  }

  function start() {
    translate();
    takeToken();
    if (!token) {
      showError(t("tokenMissing"));
      return;
    }
    $("start-button").addEventListener("click", function () {
      runAction("/api/start", true);
    });
    $("stop-button").addEventListener("click", function () {
      runAction("/api/stop", false);
    });
    $("copy-button").addEventListener("click", copyAddress);
    $("share-button").addEventListener("click", shareAddress);
    $("refresh-button").addEventListener("click", refreshLists);
    $("account-form").addEventListener("submit", submitAccount);
    $("account-reset").addEventListener("change", updateSubmitLabel);
    $("account-form").addEventListener("input", withdrawConfirm);
    $("account-form").addEventListener("change", withdrawConfirm);
    $("account-confirm-yes").addEventListener("click", confirmReset);
    $("account-confirm-no").addEventListener("click", cancelConfirm);
    $("account-copy").addEventListener("click", copyPassword);
    $("account-hide").addEventListener("click", function () {
      hidePassword();
      $("account-submit").focus();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !$("account-confirm").hidden) {
        cancelConfirm();
      }
    });
    window.addEventListener("pagehide", hidePassword);
    api("GET", "/api/config")
      .then(function (config) {
        site = config.sites[0].id;
        maxSimCount = config.maxSimCount;
        $("count-input").max = String(maxSimCount);
        $("count-input").value = String(config.simCount);
        setText("site-name", site);
        return refreshStatus();
      })
      .then(refreshLists)
      .catch(function (failure) {
        showError(describeError(failure));
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
