# Nadia Mac Centralization Plan (Immediate)

## Goal
Make MacBook the single source of truth for Nadia work, while server remains orchestrator.

## Source of Truth (Mac)
- `~/Developer/marketing-workspace/AGENTS.md`
- `~/Developer/marketing-workspace/strategy.md`
- `~/Developer/marketing-workspace/content-intel.json`
- `~/Developer/marketing-workspace/content-calendar.md`
- `~/Developer/marketing-workspace/drafts/`
- `~/Developer/marketing-workspace/memory/`

## Server Role
- Keep `marketing-agent` for scheduling/routing only.
- Cron prompts must always execute content operations via `nodes.run` on `MacBook-Local`.
- Never treat `/home/clawd/agents/marketing-workspace` as delivery evidence for content work.

## Enforcement Rules
1. GitLab status labels required: `To Do | Doing | On Hold | Blocked | Done`
2. "Assigned" is not progress.
3. Every update must include artifact evidence (paths/links/metrics).
4. Mention replies must include concrete update or next action + ETA.

## Next Implementation Step
- Add dashboard source `mac` (remote-dashboard mode) and enable it once mac dashboard endpoint is up.
