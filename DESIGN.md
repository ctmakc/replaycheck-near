# DESIGN — ReplayCheck on NEAR (live page, 2026-11-07)

Subject & audience: a QA agent that sells browser-replay runs for NEAR and pays a browser worker per minute; read by hackathon judges (humans, Claude Code, Codex) and developers. · Page job: one button runs the whole paid loop in front of the visitor and every state change lands on a board with the transaction behind it.

Direction: **Clearing-house departure board.** Swiss International discipline (flush-left, mathematical grid, one accent) with a split-flap (Solari) board as the live object. Jobs are flights: POSTED → ACCEPTED → RENTING → DELIVERED, and every flip is a transaction. Why: the product is a dispatch between agents, and a board is the one display people already read as "state changes you can trust".

Unexpected pairing / risk taken: an airport artifact for a blockchain QA tool; the board is dark machinery on a light concourse page, so the page stays light.

Palette (cool):
- `--concourse` `#E3E5E2` page background (cool greenish concrete)
- `--panel` `#F4F5F3` light panels / cards of copy
- `--board` `#1B1D21` the split-flap housing; `--flap` `#2A2D33` flap face; `--flap-edge` `#111317`
- `--ink` `#15171A` text; `--muted` `#5F646B`
- `--stamp` `#002FA7` Klein blue — the one accent: the run button, links, the "PAID" stamp
- semantic: `--delivered` `#1D7A46`, `--refund` `#C81E1E`, flap text `#F2F3EE`

Type: **Barlow Semi Condensed** 600/500 for display (56–96px, tracking −0.015em, line-height 0.95) + **Barlow** 400/500 body (16–17px/1.5) + **Fragment Mono** for every number, hash, account id, flap character (13–15px, tabular-nums). Scale ratio 1.333.

Layout primitive: **the ruled row**. Hero is a 4/8 split (copy left, board right); below it every section is a row on a 12-col grid with 1px rules: explainer rows, "what the agent bought" rows, P&L rows, judge-path rows. No cards with shadows.

Motion personality: mechanical, instant. Flap flip = two half-tiles rotateX 90° in 120ms `steps(2)` → `cubic-bezier(.2,.9,.2,1)`, letters settle one after another (28ms stagger) with a brief blur; status words flip through two intermediate glyphs. Hero: the board boots row by row (top to bottom, 60ms per row); copy lines rise from masks with an overlapping stagger. Hover: 120ms ease-out, underline grows from the left. Reduced motion: flaps set instantly, no boot sequence.

Signature element: the split-flap job board that reflects the chain — live rows for jobs with flip transitions and a mono transaction hash under each row; the Klein-blue "PAID 0.05 Ⓝ" stamp that appears on delivery.

Ledger check (2026-11-07, 469 rows): background cool concourse `#E3E5E2` + dark board object — unused; Barlow Semi Condensed + Fragment Mono — unused (Barlow Condensed once); Klein blue `#002FA7` — unused; split-flap board — unused; flap-flip motion — unused. Differs from the earlier ReplayCheck (Celo) page on all five axes (olive night / Red Hat Display / sodium yellow / receipt tape / paper feed).

Forbidden here: cream backgrounds, serif display, glassmorphism, drop shadows on cards, gradients, centered hero, fade-up as the only motion, purple/blue gradient, neon glow.
