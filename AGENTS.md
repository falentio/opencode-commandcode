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

- Plugin entry is `src/index.ts`. It **default-exports** a v2 plugin definition:
  an object `{ id, setup(ctx) }`. It does not export a v1 `Plugin` function.
- `setup(ctx)` must fetch the catalog and start the proxy **before** registering
  any transform, because `ctx.*.transform` callbacks are synchronous and their
  promise is not awaited for the mutation to land.
- The provider must be registered with
  `package: "@opencode/ai/providers/openai-compatible"`. opencode resolves its
  own bundled copy for that specifier; any other specifier produces a
  `LanguageModel` from a foreign module instance, which opencode rejects with
  `Schema validation failed`.
- `src/alpha-wire.ts` is the wire translation and is intentionally untouched.
  Treat changes there as a separate, deliberate change.
- The v2 packages are **peer dependencies**; keep them out of `dependencies`.
- Only `dist/` is published (`files` in `package.json`). Never add source to the publish payload.
- `publishConfig.access` must stay `public` — scoped packages default to private and the publish will fail otherwise.
- `repository.url` must exactly match the GitHub repo, or npm rejects the OIDC publish.
