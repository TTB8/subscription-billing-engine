#!/usr/bin/env bash
# Helpers for trying the engine by hand against Stripe TEST mode.
# See docs/stripe-test-mode.md. Only touches the local docker-compose database
# and the locally running API; it never talks to Stripe itself.
#
#   scripts/demo.sh show <subscription-id>          state, customer and saved card
#   scripts/demo.sh make-due <subscription-id>      pretend the paid cycle just ended
#   scripts/demo.sh retry-now <subscription-id>     pretend the scheduled retry time arrived
#   scripts/demo.sh swap-card <subscription-id> <pm_...>   change the saved card
#   scripts/demo.sh renew                           run the renewal job now
#   scripts/demo.sh ledger <subscription-id>        every charge, failure and refund
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/apps/api/.env"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
PM_RE='^pm_[A-Za-z0-9_]+$'

die() { echo "error: $*" >&2; exit 1; }

# Read one KEY=value from the .env file without sourcing it.
env_value() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

# Only the commands that call the API need the admin key.
load_api_settings() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy apps/api/.env.example first)"
  ADMIN_KEY="$(env_value ADMIN_API_KEY)"
  [ -n "$ADMIN_KEY" ] || die "ADMIN_API_KEY is not set in $ENV_FILE"
  BASE_URL="${BASE_URL:-http://localhost:$(env_value PORT | grep . || echo 3000)}"
}

need_uuid() { [[ "${1:-}" =~ $UUID_RE ]] || die "expected a subscription id (uuid), got '${1:-}'"; }

# Values are passed as psql variables and quoted by psql (:'name'), never spliced into SQL text.
psql_run() {
  (cd "$ROOT" && docker compose exec -T postgres psql -U billing -d billing -v ON_ERROR_STOP=1 "$@")
}

api() {
  load_api_settings
  curl -fsS -H "x-admin-key: $ADMIN_KEY" "$@" | { command -v python3 >/dev/null && python3 -m json.tool || cat; }
}

cmd="${1:-}"; shift || true
case "$cmd" in
  show)
    need_uuid "${1:-}"
    psql_run -v id="$1" -x <<'SQL'
SELECT s.id, s.status, s."termCycles", s."anchorAt", s."paidThroughAt", s."pendingStop",
       s."failureCount", s."dueAt", s."nextRetryAt", s."paymentMethodRef",
       c.email, c."stripeCustomerId"
FROM "Subscription" s JOIN "Customer" c ON c.id = s."customerId"
WHERE s.id = :'id';
SQL
    ;;
  make-due)
    need_uuid "${1:-}"
    psql_run -v id="$1" <<'SQL'
UPDATE "Subscription" SET "paidThroughAt" = now() - interval '1 minute'
WHERE id = :'id' AND status = 'active';
SQL
    echo "Next: scripts/demo.sh renew"
    ;;
  retry-now)
    need_uuid "${1:-}"
    psql_run -v id="$1" <<'SQL'
UPDATE "Subscription" SET "nextRetryAt" = now() - interval '1 minute'
WHERE id = :'id' AND status = 'past_due';
SQL
    echo "Next: scripts/demo.sh renew"
    ;;
  swap-card)
    need_uuid "${1:-}"
    [[ "${2:-}" =~ $PM_RE ]] || die "expected a Stripe payment method id (pm_...), got '${2:-}'"
    psql_run -v id="$1" -v pm="$2" <<'SQL'
UPDATE "Subscription" SET "paymentMethodRef" = :'pm' WHERE id = :'id';
SQL
    ;;
  renew)
    api -X POST "$BASE_URL/admin/renewals/run"
    ;;
  ledger)
    need_uuid "${1:-}"
    api "$BASE_URL/admin/subscriptions/$1/ledger"
    ;;
  *)
    sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
