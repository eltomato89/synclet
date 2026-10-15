# ADR 0001: Stack – NestJS + PostgreSQL, React + Tailwind + shadcn/ui

- Status: akzeptiert (2026-10-15)

## Kontext
Synclet braucht einen Server, der als Docker-Compose-Stack self-hosted läuft, und ein hochwertiges Web-Frontend. Das Schwesterprojekt Buro hat bereits einen erprobten Sync-Stack (NestJS/Fastify, Prisma, PostgreSQL) samt Euro-Office-Integration und nativen Clients.

## Entscheidung
- Server: NestJS (Fastify) + Prisma + PostgreSQL 16, Job-Queue pg-boss (kein Redis).
- Web: React + Vite + Tailwind + shadcn/ui.
- Monorepo mit pnpm-Workspaces; native Clients (Swift, .NET, Kotlin) liegen unter `apps/`, sind aber nicht Teil des pnpm-Workspace.

## Konsequenzen
- Sync-, Office- und Auth-Logik aus Buro lassen sich weitgehend portieren; der Sync-Vertrag bleibt kompatibel zu Buro SYNC_API v1.
- Mehr RAM/Image-Größe als ein Go-Binary mit SQLite; zusätzlicher Postgres-Container.
