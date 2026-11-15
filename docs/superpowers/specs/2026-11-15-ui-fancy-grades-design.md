# UI: Fancier Grade Results

## Intent
The results table reads fine, but the grade section looks flat: every grade looks
the same regardless of how good or bad it is. Make the grades the visual answer of
the test. The interactive chart is out of scope for now.

## Why it looks flat today
- Only the overall medal gets a grade class (`app.js` `renderResults`); direction
  letters are plain white, so an upload F looks like a download A+.
- A+/A share teal and D/F share red.
- The 6 px bloat meter shows only the teal end of its gradient when short, and says
  nothing about distance to the next grade.

## Goals
- Overall grade: letter inside a ring (CSS `conic-gradient`) filled by bloat ms on
  the existing 0–400 ms scale, in the grade color.
- Six distinct grade colors: A+ teal, A green, B blue, C amber, D orange, F red.
- Each direction card tinted by its own grade (letter color, background wash, border).
- Each direction card shows the numbers behind the grade: `idle p5 → loaded p90` ms
  (the inputs of the existing increase formula) and `+N ms`.
- Replace the bloat meter with a six-segment grade scale (A+…F), reached segments
  filled, plus a margin line such as "76 ms before D".

## Non-goals
- Interactive / hover chart (deferred).
- New palette, fonts, or layout grid; results table and history unchanged.
- Any change to grading thresholds or formulas (A+ <5, A <30, B <60, C <200,
  D <400, F ≥400 ms; noise floor 2 ms).

## Constraints
- Vanilla HTML/CSS/JS, no dependencies, still embedded in the server binary.
- Letter stays as text so color is never the only signal; ring and scale are
  decorative with a text equivalent (`aria-hidden` + existing labels).
- Existing `prefers-reduced-motion` rule keeps covering new animations.
- Mobile layout (≤760 px single column) keeps working.

## Approaches
1. **Elevated hero (picked)** — same grid, add ring, per-grade colors, numbers,
   and grade scale. Fixes the cause with no layout rewrite.
2. Arc gauges per direction — more instrument-like, but loses quick letter scan.
3. Editorial hero (huge letter, full-width wash) — most dramatic, pushes details
   a viewport down.

## Builder calls (mine, correctable)
- Margin line shows headroom to the next worse grade ("76 ms before D"); F shows
  distance above the D threshold ("124 ms over D").
- Withheld grade "—": neutral gray, empty ring and scale, numbers still shown when
  available.
- Overall ring uses the worst increase among the three directions (matches
  "overall = worse of down / up / both").
- Grade thresholds and the margin calculation live in `web/results.js` as a pure
  helper with a `node --test` case; `app.js` and CSS consume it.

## Verification
- `node --test web/*.test.js` including the new margin helper (each grade
  boundary, F, NaN).
- Visual check with forced grades A+…F and "—" on desktop and ≤760 px width.
