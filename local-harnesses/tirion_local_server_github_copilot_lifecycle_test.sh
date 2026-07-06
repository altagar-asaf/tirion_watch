#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# Tirion local-server GitHub Copilot lifecycle webhook stress test
#
# Copilot-only entrypoint for the maintained multi-provider lifecycle harness.
# It exercises deterministic GitHub Copilot span DB replay and validates:
# run.start, run.update, run.ended, commit.attributed, pricing coverage,
# relative changed files, request metadata, durable delivery, and privacy.
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export TIRION_TEST_PROVIDERS="${TIRION_TEST_PROVIDERS:-github-copilot}"

exec "$SCRIPT_DIR/tirion_local_server_dual_provider_lifecycle_test.sh" "$@"
