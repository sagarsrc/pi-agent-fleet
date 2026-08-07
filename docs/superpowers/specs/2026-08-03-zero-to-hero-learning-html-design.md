# Design: QuickCall Zero-to-Hero 1-Hour HTML Cram Doc

## Goal
Turn `zero-to-hero.md` (3-hour investor/lab pitch prep pack) into a single, self-contained Notion-style HTML artifact that can be consumed in ~60 minutes and used as a quick reference during a pitch or prep session.

## Output
File: `docs/learning-artifacts/quickcall-zero-to-hero.html`

## Content Structure
1. **Header** — title, source, 1-hour reading plan, emergency 4-line recap.
2. **Probe Radar (0-10 min)** — 20 challenge-ready facts with "why it matters" in a compact table.
3. **Hour 1: Foundations (10-35 min)** — pretraining vs post-training; SFT/DPO/RLHF/RLVR; QuickCall trace example; 17-term vocabulary table (collapsed by default).
4. **Hour 2: Thesis (35-55 min)** — data moat; signal taxonomy; candidate schema; prior-art numbers; open-model pick; budget tiers; 30/60/90 pilot plan; eval harness.
5. **Hour 3: Room (55-60 min)** — market map; partner frame; flywheel math; 12 hardest questions with rebuttals; risk register; open gaps.

## Visual Design
- Notion-like: `#ffffff` background, `#37352f` text, `#f7f6f3` side blocks, `#2eaadc` accents.
- System font stack (Inter / -apple-system / Segoe UI), max-width 760px, comfortable line-height.
- Minimal interactivity: sticky top TOC, native `<details>` expand/collapse for dense tables, hoverable heading anchors, back-to-top button.
- No external dependencies; everything inline in one HTML file.

## Non-goals
- No heavy SPA framework, no custom animations, no dark mode toggle, no print optimization beyond basic CSS.
- Not a full reproduction of every source link; only the high-signal ones stay inline.
