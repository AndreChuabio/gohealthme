# AI Attribution

This project uses AI-assisted development (Claude Code). Per ETHGlobal rules, AI-assisted files are listed here and kept current throughout the event.

All entries below were produced during the event (after Fri Jun 12, 9:00pm EDT) with human review by the team (Andre Chuabio, Nikki Hu).

| File / area | Nature of AI assistance |
|---|---|
| Repo scaffold (.gitignore, .env.example, README.md) | AI-generated, human-reviewed |
| contracts/src/HealthPools.sol | AI-assisted Solidity with human-defined interface (frozen in build plan) and review |
| contracts/test/HealthPools.t.sol | AI-generated Foundry tests and MockUSDC, human-reviewed |
| contracts/script/Deploy.s.sol, contracts/foundry.toml | AI-generated deploy script and config, human-reviewed |
| app/ | AI-assisted Next.js scaffold and components, human-reviewed |
| app/lib/useUsdcDeposit.ts | AI-generated reusable approve+write deposit hook (Blink swap point), human-reviewed |
| app/components/CreatePool.tsx, app/app/pools/create/page.tsx | AI-generated pool creation flow, human-reviewed |
| app/components/FundPool.tsx | AI-generated pool top-up component, human-reviewed |
| app/components/BackGoal.tsx | AI-assisted refactor onto shared deposit hook, human-reviewed |

Design decisions, architecture, and prize strategy: human-led with AI research support (documented in team notes).
