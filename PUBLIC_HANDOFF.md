# Public engineering handoff

This repository began as a clean snapshot of the active Successor monorepo:

- source commit: `cdab7dccacc1d75cd301c38158fa1e8a1ec93c73`
- source tree: `11564a1ecc9b00d0aefdada8dbaf0434d9c08000`
- browser client release: `successor-alpha@cdab7dccacc1d75c`

The snapshot intentionally excludes the local Unity renderer experiment. The
Three.js browser client, terminal client, Electron shell, site, TypeScript
server edge, Rust authority, infrastructure, verification tools, and current
runtime asset library are present.

Binary game assets use Git LFS. Install it before cloning or checking out:

```bash
git lfs install
git clone https://github.com/LycaonLLC/successor.git
cd successor
git lfs pull
```

Start with `docs/CANONICAL_CONTEXT.md`, then read
`docs/CURRENT_PROJECT_STATE.md`, `docs/CURRENT_DEPLOYMENT.md`, and
`docs/VERIFICATION.md`. Run the normal gates with:

```bash
pnpm install --frozen-lockfile
pnpm run ci
pnpm hygiene:rust
```

Do not commit credentials, local runtime state, provider sessions, or copied
home/config directories. Source moves between development and compute hosts
through Git.
