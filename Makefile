# Fleet Console task runner. `make help` lists the targets.
# `make check` runs the same gates as CI (.github/workflows). A gate whose local tool is missing
# prints SKIP and passes, because CI still runs it; with STRICT=1 it fails instead.

SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.ONESHELL:
.DEFAULT_GOAL := help
# `check` runs its gates in the order listed; a parallel run would interleave their output.
.NOTPARALLEL:

STRICT ?= 0
N ?= 9
# Console account created by make bootstrap-admin (EMAIL is required there).
EMAIL ?=
ROLE ?=
RESET ?= 0
# Port of the local demo control page (make demo-ui), on 127.0.0.1 only.
PORT ?= 8765

# Same versions as CI (.github/workflows/security.yml) and the devcontainer.
SEMGREP_VERSION := 1.181.0
ZIZMOR_VERSION := 1.31.1
PIP_AUDIT_VERSION := 2.10.1

# Same release-age delay as security.yml for the transitive dependencies of uvx tools.
export UV_EXCLUDE_NEWER := 14 days

TF_ROOTS := infra/bootstrap infra/envs/demo

# A tool that is optional locally: skip the calling target when it is missing, or fail under
# STRICT=1. `exit 0` ends the single shell that runs the whole recipe, so only this target stops.
define need
command -v $(1) >/dev/null 2>&1 || { if [ "$(STRICT)" = 1 ]; then echo "FAIL: $(1) not installed (STRICT=1)" >&2; exit 1; fi; echo "SKIP: $(1) not installed; CI runs this check" >&2; exit 0; }
endef

# A tool every developer must have (installed by .devcontainer/post-create.sh): always fail.
define require
command -v $(1) >/dev/null 2>&1 || { echo "FAIL: $(1) is required; see .devcontainer/post-create.sh" >&2; exit 1; }
endef

.PHONY: help install hooks fmt lint test openapi dev agent sim demo demo-start demo-stop demo-ui links destroy video-page video-page-check \
	check check-ts check-generated check-py check-tf check-shell check-tflint check-checkov \
	check-secrets check-sast check-trivy check-deps check-workflows \
	smoke publish-console bootstrap-admin rollback e2e-setup e2e e2e-teardown

## Quality gates

check: check-ts check-generated check-py check-tf check-shell check-tflint check-checkov check-secrets check-sast check-trivy check-deps check-workflows ## Run every quality gate, in CI order
	echo "make check: all gates completed; SKIP lines are checks that only CI runs locally"

check-ts: ## TypeScript: format, lint, types, unit tests with coverage, build, CSP and fixture checks of the built page
	$(call require,pnpm)
	pnpm format:check
	pnpm lint
	pnpm typecheck
	pnpm test:coverage
	$(MAKE) video-page-check
	pnpm build
	node scripts/check-console-csp.mjs
	node scripts/check-console-fixtures.mjs
	node --test scripts/check-console-csp.test.mjs scripts/e2e-scan-report.test.mjs scripts/e2e-scripts.test.mjs

check-generated: ## Generated OpenAPI and protocol artifacts are up to date and committed
	$(call require,pnpm)
	pnpm --filter @mfc/protocol generate
	out="$$(git status --porcelain -- packages/protocol/generated services/api/openapi.json docs/STATE_MACHINE.md)"
	if [ -n "$$out" ]; then
	  echo "FAIL: generated files are stale; run 'make openapi' and commit the result:" >&2
	  echo "$$out" >&2
	  exit 1
	fi

check-py: ## Python agent: format, lint, mypy --strict, tests with 80 % coverage
	$(call require,uv)
	cd agent
	uv sync --frozen --all-extras
	uv run ruff format --check .
	uv run ruff check .
	uv run mypy --strict src tools
	uv run pytest --cov=fleet_agent --cov-report=term-missing --cov-fail-under=80
	uv run coverage report --include='*/fleet_agent/core/*' --fail-under=90

check-tf: ## Terraform: fmt check, IoT policy inventory, then init without backend and validate each existing root
	$(call need,terraform)
	terraform fmt -check -recursive infra
	bash scripts/check-iot-inventory.sh
	for root in $(TF_ROOTS); do
	  if [ ! -d "$$root" ]; then
	    echo "SKIP: $$root does not exist yet (created in M2)" >&2
	    continue
	  fi
	  # A separate, disposable data directory keeps these offline checks from reading the S3 backend that a
	  # real plan or apply records in <root>/.terraform/terraform.tfstate, which would otherwise fail every
	  # check without credentials. The first run downloads the providers once more into it.
	  export TF_DATA_DIR="$$PWD/.terraform-check/$$(basename "$$root")"
	  terraform -chdir="$$root" init -backend=false -input=false
	  terraform -chdir="$$root" validate
	  if [ -d "$$root/tests" ]; then
	    terraform -chdir="$$root" test
	  fi
	done

# The CI workflows do not run ShellCheck yet, so the SKIP message says so rather than promising a CI run.
check-shell: ## ShellCheck of scripts/, the operator and repository check scripts (SKIP locally when not installed)
	if ! command -v shellcheck >/dev/null 2>&1; then
	  if [ "$(STRICT)" = 1 ]; then echo "FAIL: shellcheck not installed (STRICT=1)" >&2; exit 1; fi
	  echo "SKIP: shellcheck not installed; install it to run this check locally" >&2
	  exit 0
	fi
	shellcheck scripts/*.sh

check-tflint: ## TFLint with the Terraform and AWS rulesets
	$(call need,tflint)
	tflint --init
	tflint --recursive --config "$(CURDIR)/.tflint.hcl"

check-checkov: ## Checkov misconfiguration scan of infra/
	$(call need,checkov)
	checkov -d infra --framework terraform --quiet --skip-path infra/.terraform

check-secrets: ## Gitleaks over the full git history
	$(call need,gitleaks)
	gitleaks git --redact --no-banner .

check-sast: ## Semgrep SAST, blocking on ERROR findings, with the same rules as CI
	$(call require,uv)
	uvx --from semgrep==$(SEMGREP_VERSION) semgrep scan \
	  --config p/default --config p/typescript --config p/react \
	  --config p/python --config p/terraform --config p/github-actions \
	  --config .semgrep/ \
	  --severity ERROR --error --metrics off

check-trivy: ## Trivy: vulnerabilities, IaC misconfigurations and secrets (HIGH and CRITICAL)
	$(call need,trivy)
	trivy fs . --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --ignore-unfixed \
	  --exit-code 1 --ignorefile .trivyignore --skip-dirs '**/node_modules' --skip-dirs agent/.venv --skip-dirs .terraform-check

check-deps: ## Dependency audits: pnpm (production, then all) and pip-audit on the locked Python set
	$(call require,pnpm)
	$(call require,uv)
	pnpm audit --prod --audit-level high
	pnpm audit --audit-level critical
	requirements="$$(mktemp)"
	trap 'rm -f "$$requirements"' EXIT
	(cd agent && uv export --frozen --no-dev --no-emit-project --format requirements-txt > "$$requirements")
	uvx pip-audit==$(PIP_AUDIT_VERSION) --strict --disable-pip --require-hashes --requirement "$$requirements"

check-workflows: ## GitHub Actions hardening with zizmor
	$(call require,uv)
	GH_TOKEN="$${GH_TOKEN:-$$(gh auth token 2>/dev/null || true)}"
	export GH_TOKEN
	uvx zizmor==$(ZIZMOR_VERSION) --min-severity medium .github/workflows

## Development

install: ## Install JS and Python dependencies, then the git hooks
	$(call require,pnpm)
	$(call require,uv)
	pnpm install --frozen-lockfile
	(cd agent && uv sync --frozen --all-extras)
	$(MAKE) hooks

hooks: ## Install the pre-commit and pre-push git hooks
	$(call require,pre-commit)
	pre-commit install --hook-type pre-commit --hook-type pre-push

fmt: ## Apply the formatters: prettier, ruff, terraform
	$(call require,pnpm)
	$(call require,uv)
	$(call require,terraform)
	pnpm format
	(cd agent && uv run ruff format .)
	terraform fmt -recursive infra

lint: ## Linters: ESLint, ruff, mypy --strict
	$(call require,pnpm)
	$(call require,uv)
	pnpm lint
	(cd agent && uv run ruff check . && uv run mypy --strict src tools)

test: ## Unit tests for TypeScript and Python
	$(call require,pnpm)
	$(call require,uv)
	pnpm test
	(cd agent && uv run pytest)

openapi: ## Regenerate the OpenAPI document and protocol artifacts
	$(call require,pnpm)
	pnpm generate

dev: ## Console on the Vite dev server, against the deployed API
	$(call require,pnpm)
	pnpm --filter @mfc/console dev

agent: ## Run the robot agent for ROBOT=<robot-id> on this machine; prints the local video page address on stderr
	$(call require,uv)
	@test -n "$(ROBOT)" || { echo "usage: make agent ROBOT=<robot-id>" >&2; exit 2; }
	cd agent
	uv run fleet-agent run --robot-id "$(ROBOT)"

video-page: ## Build the local video page into agent/src/fleet_agent/video/static/ (commit the result, ADR 0037)
	$(call require,pnpm)
	pnpm --filter @mfc/robot-video build

# Runs before `pnpm build` in check-ts: that build writes the same folder, so a hand edit would be
# overwritten before a comparison and pass. Comparing a fresh build with the committed folder first fails
# on any edit, and on any build that is not reproducible.
video-page-check: ## The committed video page equals a fresh build, byte for byte (fails on drift)
	$(call require,pnpm)
	work="$$(mktemp -d)"
	trap 'rm -rf "$$work"' EXIT
	pnpm --filter @mfc/robot-video exec vite build --outDir "$$work/static"
	node apps/robot-video/scripts/write-manifest.mjs "$$work/static"
	if ! diff -r "$$work/static" agent/src/fleet_agent/video/static; then
	  echo "FAIL: the committed video page differs from a fresh build; run 'make video-page' and commit the result" >&2
	  exit 1
	fi

sim: export SIM_N := $(N)
sim: ## Simulated robots, N from 1 to 20 (default 9), auto-stop after 2 h; the kits must exist
	@case "$$SIM_N" in
	  ''|*[!0-9]*) echo "make sim: N must be an integer from 1 to 20" >&2; exit 2 ;;
	esac
	if [ "$$SIM_N" -lt 1 ] || [ "$$SIM_N" -gt 20 ]; then
	  echo "make sim: N must be an integer from 1 to 20" >&2
	  exit 2
	fi
	bash scripts/sim.sh

demo: ## Start the demo (consumer, N simulators, default 9) and print the links; running it again is safe
	$(call require,aws)
	SIM_N=$(N) bash scripts/demo.sh

links: ## Print the three read-only links: console, Cognito users, IoT things
	$(call require,uv)
	bash scripts/links.sh

demo-ui: ## Local control page on 127.0.0.1 (PORT, default 8765); open the URL it prints
	$(call require,uv)
	uv run --project agent python -m fleet_agent.demo_ui --port $(PORT)

demo-start: ## Enable the ingest consumer, so that the live data reaches the console
	$(call require,aws)
	bash scripts/demo-consumer.sh enable

KEEP_CONSUMER ?= 0

demo-stop: ## Stop the local simulators, then disable the ingest consumer (KEEP_CONSUMER=1 keeps it on)
	stop_rc=0
	bash scripts/sim-stop.sh || stop_rc=$$?
	# The consumer is disabled even when the simulator did not stop: the cost guard must not depend on
	# the simulator's status. The worst of the two statuses is the status of the target.
	consumer_rc=0
	if [ "$(KEEP_CONSUMER)" != 1 ]; then
	  $(call require,aws)
	  bash scripts/demo-consumer.sh disable || consumer_rc=$$?
	fi
	if [ "$$consumer_rc" -gt "$$stop_rc" ]; then stop_rc=$$consumer_rc; fi
	exit $$stop_rc

destroy: ## Destroy the demo environment (interactive, the owner only)
	if [ ! -t 0 ]; then
	  echo "make destroy must be run interactively by the owner" >&2
	  exit 1
	fi
	read -r -p 'Type "destroy demo" to confirm: ' phrase
	if [ "$$phrase" != "destroy demo" ]; then
	  echo "Aborted: the confirmation phrase did not match." >&2
	  exit 1
	fi
	if [ ! -d infra/envs/demo ]; then
	  echo "nothing to destroy before M2" >&2
	  exit 1
	fi
	$(call require,terraform)
	terraform -chdir=infra/envs/demo init -input=false
	# The budgets outlive the demo (PLAN M12, ADR 0023): they leave the state so that the
	# environment teardown does not touch them, and the import blocks re-adopt them on the next
	# deploy. The list is captured first: grep -q in a pipe would end it early and fail under pipefail.
	# A missing state makes "state list" fail; there is then nothing to remove, and if the budgets
	# were still tracked, prevent_destroy makes the teardown below fail closed.
	state_list="$$(terraform -chdir=infra/envs/demo state list || true)"
	if grep -q '^aws_budgets_budget\.this\[' <<<"$$state_list"; then
	  terraform -chdir=infra/envs/demo state rm 'aws_budgets_budget.this'
	fi
	terraform -chdir=infra/envs/demo destroy -input=false

## Deployment (called by .github/workflows/deploy.yml)
# Recipe exit codes, as make reports them in "Error N": 1 = failure, 2 = usage error.

smoke: ## Post-deploy checks: CloudTrail logging and delivery, alarm topic, IoT robot identity, and the console when CONSOLE_URL is set
	$(call require,aws)
	$(call require,terraform)
	$(call require,jq)
	outputs="$$(terraform -chdir=infra/envs/demo output -json \
	  | jq -er '[.trail_name.value, .alarm_topic_arn.value] | if all(type == "string" and . != "") then join("\t") else error("missing") end')" || {
	  echo "smoke: Terraform outputs are unavailable in infra/envs/demo (no state, or not initialised); run the deploy first" >&2
	  exit 1
	}
	IFS=$$'\t' read -r trail topic <<<"$$outputs"
	logging="$$(aws cloudtrail get-trail-status --name "$$trail" --query IsLogging --output text)" || {
	  echo "smoke: cannot read the CloudTrail trail status" >&2
	  exit 1
	}
	if [ "$$logging" != "True" ]; then
	  echo "smoke: the CloudTrail trail is not logging" >&2
	  exit 1
	fi
	delivery_error="$$(aws cloudtrail get-trail-status --name "$$trail" --query LatestDeliveryError --output text)" || {
	  echo "smoke: cannot read the CloudTrail delivery status" >&2
	  exit 1
	}
	if [ -n "$$delivery_error" ] && [ "$$delivery_error" != "None" ]; then
	  echo "smoke: the CloudTrail trail reports a delivery error" >&2
	  exit 1
	fi
	aws sns get-topic-attributes --topic-arn "$$topic" >/dev/null || {
	  echo "smoke: the alarm SNS topic cannot be read" >&2
	  exit 1
	}
	# A warning, not a failure: the first deploy always starts with an unconfirmed subscription.
	confirmed="$$(aws sns get-topic-attributes --topic-arn "$$topic" --query Attributes.SubscriptionsConfirmed --output text)" || {
	  echo "smoke: cannot read the alarm SNS subscriptions" >&2
	  exit 1
	}
	if [ "$$confirmed" = "0" ]; then
	  echo "::warning::smoke: the alarm e-mail subscription is not confirmed yet; confirm it from the AWS e-mail"
	fi
	bash scripts/smoke-iot.sh
	if [ -n "$${CONSOLE_URL:-}" ]; then
	  bash scripts/smoke-console.sh "$$CONSOLE_URL"
	fi
	echo "smoke: OK (trail logging and delivery, alarm topic, IoT robot identity)"

publish-console: ## Build the console, write its runtime config, upload it and invalidate index.html and config.json
	$(call require,aws)
	$(call require,jq)
	$(call require,pnpm)
	$(call require,terraform)
	bash scripts/publish-console.sh

bootstrap-admin: ## Create or update a console account (EMAIL=..., ROLE=Admin|Operator|Viewer: Admin by default for a new account, required for an existing one; RESET=1 issues a new temporary password)
	$(call require,aws)
	$(call require,openssl)
	$(call require,terraform)
	ROLE="$(ROLE)" RESET="$(RESET)" bash scripts/bootstrap-admin.sh "$(EMAIL)"

rollback: ## Roll back a failed deploy (ships with the console milestone and Lambda aliases)
	@echo "rollback: automated rollback ships with the console and Lambda aliases; for infra, revert the merge commit and let deploy re-apply" >&2
	exit 1

e2e-setup: ## Create the ephemeral e2e operator and simulated robot (CONSOLE_URL, AWS_REGION and an e2e role session)
	$(call require,aws)
	$(call require,curl)
	$(call require,jq)
	$(call require,openssl)
	$(call require,uv)
	bash scripts/e2e-setup.sh

e2e: ## Playwright demo scenario against the deployed console; run e2e-setup first, then scan the report for secrets
	$(call require,pnpm)
	state_dir="$$(. scripts/e2e-state-dir.sh && e2e_state_dir)" || exit 1
	state="$$state_dir/state.json"
	if [ ! -f "$$state" ]; then
	  echo "make e2e: run make e2e-setup first" >&2
	  exit 1
	fi
	# The browser test runs with an allowlisted environment: no AWS, CI or GitHub variable reaches it (ADR 0069).
	rc=0
	env -i PATH="$$PATH" HOME="$$HOME" LANG="$${LANG:-C.UTF-8}" TMPDIR="$${TMPDIR:-/tmp}" E2E_STATE_FILE="$$state" \
	  pnpm --filter @mfc/console exec playwright test || rc=$$?
	node scripts/e2e-scan-report.mjs "$$state" apps/console/playwright-report || rc=1
	exit $$rc

e2e-teardown: ## Delete the ephemeral e2e operator and robot and its state (safe to run twice)
	bash scripts/e2e-teardown.sh

help: ## List the available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  %-16s %s\n", $$1, $$2 }'
