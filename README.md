# Agency Platform — Version 1 foundation

A multi-client content calendar, task management, asset/review groundwork and
reporting platform for a digital marketing agency. This is the **foundation
slice** of the Version 1 scope agreed in chat: project setup, database, login,
roles, client isolation, the calendar, tasks, comments and core reports — the
piece everything else (asset review, notifications, full reporting) builds on.

## What's built

- **Auth & permissions**: JWT session cookie login, 5 roles (admin, manager,
  team_member, freelancer, client), a deny-by-default policy layer enforced
  server-side and re-checked at every route (never just hidden in the UI).
- **Clients**: create clients, assign staff to them; a client contact only
  ever sees their own account.
- **Content calendar**: multi-client and per-client views, channel/format/
  publish date, filtering.
- **Task management**: deliverables with stages (Brief → Production →
  Internal Review → Client Review → Approved), priorities, due dates,
  assignees, dependencies (a blocked task can't skip ahead), checklists,
  comments split into internal vs. client-visible.
- **Reports**: deliverables-by-stage, overdue items, team workload, and
  stage-turnaround built from an append-only stage-transition log.
- **Web app**: login, dashboard, calendar, Kanban task board, clients list,
  deliverable detail (checklist + comments), and an admin invite flow.
- **Automated permission tests**: 18 tests that log in as every role and
  prove client isolation, freelancer scoping, internal-note hiding, and
  admin-only actions actually hold — not just intended.

## What's next (already scoped, not yet built)

Asset library with versioned review/approval and pinned feedback, the
remaining reports (planned vs. actual hours, published vs. planned,
scheduled exports), and reminders/notifications. See the development plan
doc for the full roadmap.

## Stack

- **API**: Express + TypeScript, Drizzle ORM, PostgreSQL, Zod validation,
  JWT cookie auth, bcrypt.
- **Web**: Next.js 14 (App Router) + TypeScript + Tailwind CSS.
- **Tests**: Vitest + Supertest against a real Postgres test database.

Prisma was the original plan but its engine binaries are fetched from a
domain this environment's network policy blocks — Drizzle is pure
JS/TypeScript and needed no native downloads, so the schema and all queries
are written against it instead.

## Running it locally

Requires Node 20+ and a local PostgreSQL server.

```bash
# 1. Install everything (npm workspaces)
npm install

# 2. Create two databases and a role (adjust to your local Postgres setup)
psql -c "CREATE ROLE agency_app LOGIN PASSWORD 'agency_app_dev_pw';"
psql -c "CREATE DATABASE agency_dev OWNER agency_app;"
psql -c "CREATE DATABASE agency_test OWNER agency_app;"

# 3. Push the schema (apps/api/.env already points at agency_dev)
cd apps/api
npm run db:push
DATABASE_URL="postgresql://agency_app:agency_app_dev_pw@localhost:5432/agency_test" npm run db:push

# 4. Seed demo data (creates a demo agency with 5 users, password: Password123!)
npm run seed

# 5. Run the API
npm run dev            # http://localhost:4000

# 6. In another terminal, run the web app
cd ../web
npm run dev            # http://localhost:3000

# 7. Run the permission test suite
cd ../api
npm test
```

### Demo logins (password: `Password123!`)


## Project layout

```
apps/
  api/            Express API, Drizzle schema, permission tests
    src/
      db/         schema.ts (tables + relations), client.ts, seed.ts
      lib/        auth (JWT/bcrypt), config
      middleware/ authenticate, error handling
      policy/     ActorScope (row-level access) + the policy layer
      routes/     auth, users, clients, content-items, deliverables, reports, stages
    tests/        permissions.test.ts — the "prove it" suite
  web/            Next.js app (App Router)
    src/
      app/        pages, grouped by (app) for the authenticated shell
      context/    AuthContext (session, current user)
      lib/        api.ts fetch wrapper, shared types
packages/
  shared/         Role/permission table and default stages, shared by both apps
```

## Security notes for anyone continuing this

- The permission model has two layers: `ROLE_ACTIONS` in
  `packages/shared/src/roles.ts` says what a role can do *in general*;
  `apps/api/src/policy/policy.ts` + `actorScope.ts` say what *this specific
  user* can do to *this specific record* (their assigned clients, their own
  client account, their own assigned deliverables). Both must agree before
  an action is allowed — see `tests/permissions.test.ts` for the cases this
  guards against.
- User invites currently return the accept link directly in the API
  response instead of emailing it (no email provider is wired up yet) — the
  web app's Team page surfaces it as a copyable link with a note explaining
  why.
- Passwords are hashed with bcrypt (cost 12); JWTs are stored in an
  httpOnly, sameSite=lax cookie, 7-day expiry.
