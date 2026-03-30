#!/usr/bin/env bash
# One-time GitHub repo setup for CI/CD
# Run this AFTER pushing to GitHub for the first time.
#
# Usage:
#   ./scripts/setup-github.sh
#
# Prerequisites:
#   - gh CLI authenticated (gh auth status)
#   - Repo pushed to GitHub (git push -u origin main)

set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
if [ -z "$REPO" ]; then
  echo "Error: Not in a GitHub repository. Push to GitHub first."
  exit 1
fi

echo "Configuring $REPO..."
echo ""

# 1. Enable auto-merge on the repo
echo "1/3  Enabling auto-merge..."
gh api -X PATCH "repos/$REPO" \
  -f allow_auto_merge=true \
  -f delete_branch_on_merge=true \
  --silent
echo "     Done."

# 2. Set branch protection on main
# Requires the "Validate" CI job and "Dependency Review" to pass before merging.
echo "2/3  Setting branch protection on main..."
gh api -X PUT "repos/$REPO/branches/main/protection" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["Validate", "Dependency Review"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
echo "     Done."

# 3. Enable Dependabot security alerts + updates
echo "3/3  Enabling Dependabot alerts..."
gh api -X PUT "repos/$REPO/vulnerability-alerts" --silent 2>/dev/null || true
gh api -X PUT "repos/$REPO/automated-security-fixes" --silent 2>/dev/null || true
echo "     Done."

echo ""
echo "================================================"
echo "  Setup complete for $REPO"
echo ""
echo "  Branch protection: main requires CI to pass"
echo "  Auto-merge: enabled (Dependabot minor/patch)"
echo "  Dependabot: alerts + security fixes enabled"
echo "  Stale branches: auto-deleted after merge"
echo "================================================"
