# AGENTS.md

Guidance for agents working in this repository.

## Project

`@falentio/opencode-commandcode` — an [OpenCode](https://opencode.ai) plugin published to npm.

- Build: Vite+ (`vp pack`, tsdown under the hood) → `dist/`
- Package manager: pnpm (see `packageManager` in `package.json`)
- Tests: Vitest via `vp test`
- Publishing: npm trusted publishing (OIDC) from GitHub Actions on `v*` tags

## Vendored references

`docs/vendor/` holds third-party repos cloned for reference. It is **gitignored** — never commit it, and never treat its contents as part of this package.

### Setup

Clone these only when they do not already exist:

```bash
[ -d docs/vendor/9router ] || git clone --depth=1 https://github.com/decolua/9router docs/vendor/9router
```

| Path                  | Source                            | Why                            |
| --------------------- | --------------------------------- | ------------------------------ |
| `docs/vendor/9router` | https://github.com/decolua/9router | 9Router AI router, an OpenCode client |

Notes:

- Use `--depth=1`. These are read-only references; history is not needed.
- Freshly cloned, so they can be deleted and re-cloned at any time.
- They carry their own nested `.git`, `node_modules`, and licenses. Do not edit them to fit this repo.

## Commands

```bash
pnpm install        # install deps
pnpm dev            # vp pack --watch
pnpm typecheck      # tsc --noEmit
pnpm test           # vp test
pnpm build          # vp pack
pnpm release        # bumpp: bump + commit + tag
```

## Conventions

- Plugin entry is `src/index.ts` and must export a `Plugin` from `@opencode-ai/plugin`.
- `@opencode-ai/plugin` is a **peer dependency**; keep it out of `dependencies`.
- Only `dist/` is published (`files` in `package.json`). Never add source to the publish payload.
- `publishConfig.access` must stay `public` — scoped packages default to private and the publish will fail otherwise.
- `repository.url` must exactly match the GitHub repo, or npm rejects the OIDC publish.
