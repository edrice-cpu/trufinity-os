# TruFinity Backend Agent Rules

Read `docs/ai/STATUS.md` before making project changes; it is the concise shared handoff for Codex and Claude Code.

- Preserve `CLAUDE.md` and all existing safety restrictions.
- Treat local PostgreSQL as shared production: no connections, queries, migrations, seeds, or mutations without explicit authorization.
- No Gmail, Google Workspace, ServiceTitan, QuickBooks, SMTP, AWS, deployment, PM2, live workers, or external API calls unless explicitly authorized.
- Do not edit `.env`, frontend code, or unrelated integrations for a scoped task.
- No Git commits, pushes, merges, resets, or branch switching.
- Prefer minimal file inspection, static review, mocked tests, and TypeScript checks.
- Preserve Gmail mailbox/content privacy and client-only dashboard authorization.
- Google Workspace TEST mail goes only to `WORK_ITEM_NOTIFICATION_RECIPIENT`.
- Never log credentials, tokens, raw provider responses, or customer content.
- Mark facts as implemented/verified, reported, confirmed, or pending; never claim production migrations ran without evidence.
