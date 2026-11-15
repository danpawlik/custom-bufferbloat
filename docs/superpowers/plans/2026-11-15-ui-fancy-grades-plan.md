# Fancy Grades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the grade hero the visual answer by adding a conic ring, 6 distinct grade colors, per-card tints, idle→loaded numbers, and a 6-segment scale with margin line.

**Architecture:** Pure functions in `web/results.js` (consumed by both `web/app.js` and `node --test`) compute grade color, rank, and margin; `web/style.css` adds ring/scale/grade washes; `web/app.js` wires the helpers into `renderResults` without changing layout grid or Go code.

**Tech Stack:** Vanilla HTML/CSS/JS, Go static serve via `web/embed.go` unchanged. Tests `node --test web/*.test.js`.

**Spec:** `docs/superpowers/specs/2026-11-15-ui-fancy-grades-design.md`

## Global Constraints

- Vanilla HTML/CSS/JS, no dependencies, still embedded in server binary.
- Letter stays as text; ring/scale decorative (`aria-hidden`).
- Existing `prefers-reduced-motion` rule keeps covering animations.
- Mobile single column at ≤760px keeps working.
- Grade thresholds unchanged: A+ <5, A <30, B <60, C <200, D <400, F ≥400, noise floor 2 ms in `increaseMs`.

## Review Focus

1. Withheld grade "—" (NaN increase) — ring empty, scale empty, numbers still shown when available.
2. Exact threshold boundaries (4.9→A+, 5→A, 29→A, 30→B, 400→F) — next-grade calculation must flip correctly.
3. bloat = `loaded p90 - idle p5` clamped to ≥0 after 2 ms floor — direction card numbers must match overall's delta inputs.
4. F grade has no next worse grade — margin shows "over D" distance instead of "before X".
5. Long label + 6-segment scale on ≤760px — no overflow or horizontal scroll.

---

## File Structure

- `web/results.js` — pure helpers: `GRADE_COLORS`, `gradeColor(g)`, `gradeThresholds`, `nextGrade(incMs)` / `gradeMargin(incMs)` (exact name builder picks, document in Interfaces).
- `web/results.test.js` — node tests for the new helper.
- `web/app.js` — consumes helpers in `renderResults` to set overall ring, per-card tints, numbers line, scale fill + margin line; defines `gradeClass` remains, `bloatWidth` replaced/supplemented.
- `web/style.css` — ring (`conic-gradient`), per-grade washes, 6-segment scale, margin line, larger overall letter.
- `web/index.html` — minimal markup tweaks inside `#gradeOverall` (ring wrapper) and `.grade-card` (numbers line, scale container) — no grid restructure.

### Task 1: Grade helpers and margin math in results.js

**Files:**
- Modify: `web/results.js`
- Test: `web/results.test.js`

**Interfaces:**
- Consumes: existing `gradeForIncrease`-equivalent thresholds; `Percentile`-style stat helpers not needed.
- Produces:
  - `GRADE_COLORS: Record<string,string>` mapping `"A+"→"#2ee6c5", A→"#4ade80", B→"#5b9dff", C→"#fbbf24", D→"#fb923c", F→"#f87171", "—"→"#334155"`
  - `gradeColor(grade:string): string`
  - `gradeInfo(increaseMs:number): {grade:string, color:string, nextGrade:string|null, marginMs:number|null, label:string}` where `label` is `"X ms before <next>"` or `"X ms over D"` for F, `"—"` / `null` margin for withheld.

- [ ] **Step 1: Write failing test for grade helpers**

```js
import assert from "node:assert/strict";
import { gradeInfo, gradeColor } from "../web/results.js"; // if CJS, use require
// assert gradeInfo(0).grade==="A+" && gradeInfo(0).color==="#2ee6c5"
// assert gradeInfo(4.9).nextGrade==="A" && gradeInfo(4.9).margin≈0.1
// assert gradeInfo(5).grade==="A" && gradeInfo(29).nextGrade==="B"
// assert gradeInfo(400).grade==="F" && gradeInfo(400).nextGrade===null
// assert Number.isNaN(gradeInfo(NaN).margin) or null per spec
// assert gradeColor("C")==="#fbbf24"
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test web/results.test.js`
Expected: FAIL — `gradeInfo` not defined.

- [ ] **Step 3: Implement helpers in web/results.js**

Add `GRADE_COLORS`, thresholds array `[{grade:"A+",max:5},{grade:"A",max:30},{grade:"B",max:60},{grade:"C",max:200},{grade:"D",max:400},{grade:"F",max:Infinity}]`, then `gradeColor` and `gradeInfo` per interfaces. `marginMs` is `nextMax - increaseMs` for non-F, `increaseMs - 400` for F, `null` for withheld. Export alongside existing `TestResults` API (add to `api` object and `module.exports`).

- [ ] **Step 4: Run tests to pass**

Run: `node --test web/results.test.js`
Expected: PASS including existing 14 tests plus new boundary cases.

- [ ] **Step 5: Commit**

```bash
git add web/results.js web/results.test.js
git commit -m "feat(web): add grade color and margin helpers"
```

### Task 2: Ring, per-grade washes, and scale styles

**Files:**
- Modify: `web/style.css`

**Interfaces:**
- Consumes: `GRADE_COLORS` values from Task 1 (hardcoded same hex in CSS custom props).
- Produces: CSS classes `.medal` ring, `.grade-A-plus`..`.grade-F` + `.grade-none`, `.grade-card.grade-*`, `.grade-ring`, `.grade-scale`, `.grade-scale-seg`, `.grade-margin`.

- [ ] **Step 1: Add CSS for grade palette and ring**

In `web/style.css` near `.medal` section:
- Define `--g-A-plus:#2ee6c5; --g-A:#4ade80; --g-B:#5b9dff; --g-C:#fbbf24; --g-D:#fb923c; --g-F:#f87171; --g-none:#334155;`
- `.medal .grade-ring` is 120px circle with `conic-gradient(var(--grade-color) calc(var(--ring-pct)*1%), transparent 0)` + inner mask; `.medal.grade-F` etc set `--grade-color`.
- Increase `.medal .grade` to 3.2rem clipped text; add per-grade overrides for letter color via `--grade-color`.
- `.grade-card.grade-A-plus` etc set `border-color`/`background: color-mix(in srgb, var(--grade-color) 10%, var(--panel-2))` and `.grade` letter `color: var(--grade-color)`.
- `.grade-scale` is 6 flex segments, each `flex:1` with `background` filled if segment index ≤ grade rank; `.grade-margin` is 0.78rem mono, muted.

- [ ] **Step 2: Verify visual locally**

Run: `go run ./cmd/server -listen :8081` and open `http://127.0.0.1:8081`, inject forced grades via console `renderResults` mock or temp JS setting `gradeOverallCard.className="medal grade-F"` to eyeball all 7 states at desktop and ≤760px.

- [ ] **Step 3: Commit**

```bash
git add web/style.css
git commit -m "style(web): grade ring, six grade colors, and segment scale"
```

### Task 3: Wire numbers, ring, tints, and margin into renderResults

**Files:**
- Modify: `web/app.js` (renderResults, helpers)
- Modify: `web/index.html` (minimal markup inside #gradeOverall and .grade-card)

**Interfaces:**
- Consumes: `TestResults.gradeInfo` / `TestResults.gradeColor` from Task 1, CSS classes from Task 2.
- Produces: `renderResults` now sets per-direction `idle p5 → loaded p90` line, tint class per card, ring `--ring-pct` on overall, and scale + margin line.

- [ ] **Step 1: Update markup in web/index.html**

Inside `#gradeOverall` wrap letter with `<span class="grade-ring" aria-hidden="true"></span><span class="grade">` (or add ring as pseudo-element target). Inside each `.grade-card` after `.grade` add `<span class="grade-numbers" id="numbersDown">` and replace `.bloat-meter` block with `<div class="grade-scale" id="scaleDown" aria-hidden="true"><span></span>×6</div><span class="grade-margin" id="marginDown">`.

- [ ] **Step 2: Wire helpers in web/app.js**

In `renderResults`:
- Compute `downIdleP5 = percentile([...idle.samples].sort(...),5)`, `downLoadedP90` similarly; same for up/bi (reuse existing sorts or add helper `p5p90`).
- For overall: `info=TestResults.gradeInfo(worseInc)` where `worseInc = Math.max(downInc, upInc, biInc)` (already have incs); set `gradeOverallCard.style.setProperty("--ring-pct", Math.min(100, worseInc/400*100))` and `gradeOverallCard.style.setProperty("--grade-color", info.color)` or rely on class.
- For each direction: set `card.className="grade-card "+gradeClass(g)` → extend to include grade color class consumed by CSS; set numbers line `fmtMs(idleP5)+" → "+fmtMs(loadedP90)+" · +"+fmtMs(inc)`; fill scale by adding `filled` to first `rank+1` segments; set margin line via `info.label`.

- [ ] **Step 3: Run JS tests and manual render**

Run: `node --test web/*.test.js`
Expected: PASS (helpers unchanged contract)

Run: `go run ./cmd/server -listen :8081` and trigger a synthetic run (or inject `ctx` with NaN to test withheld path) to verify ring/scale/margin at A+, C, F, and "—".

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat(web): tint direction cards, show idle→loaded and margin scale"
```

### Task 4: Polish and a11y pass

**Files:**
- Modify: `web/style.css`, `web/index.html` if needed
- Modify: `web/results.test.js` (add withheld edge case if missing)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Add withheld-state test**

Assert `gradeInfo(NaN).grade==="—"` and label is `"—"` or `"Incomplete sample"` and `marginMs===null`; ring 0% and scale 0 filled.

- [ ] **Step 2: Ensure a11y and reduced-motion**

Verify `.grade-ring` and `.grade-scale` are `aria-hidden`, numbers/margin duplicates the info as text; confirm `@media (prefers-reduced-motion: reduce)` suppresses new animations.

- [ ] **Step 3: Run full suite**

Run: `go test -race ./... && node --test web/*.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/results.test.js web/style.css web/index.html
git commit -m "test(a11y): withheld grade and reduced-motion coverage"
```
