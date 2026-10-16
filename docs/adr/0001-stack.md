# ADR 0001: Stack – NestJS + PostgreSQL, React + Tailwind + shadcn/ui

- Status: accepted (2026-10-15)

## Context
Synclet needs a server that runs self-hosted as a Docker Compose stack, and a high-quality web frontend. A proven stack (NestJS/Fastify, Prisma, PostgreSQL) including the Euro-Office integration is available.

## Decision
- Server: NestJS (Fastify) + Prisma + PostgreSQL 16, pg-boss job queue (no Redis).
- Web: React + Vite + Tailwind + shadcn/ui.
- Monorepo with pnpm workspaces; native clients (Swift, .NET, Kotlin) live under `apps/` but are not part of the pnpm workspace.

## Consequences
- Sync, office and auth logic can be implemented well with this stack; the sync contract is described in docs/sync/SYNC_API.md.
- More RAM/image size than a Go binary with SQLite; an additional Postgres container.
