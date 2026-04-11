# Dropp — Frontend Layout & Button Placement Issues

**Date:** 2026-04-11  
**Reviewed via:** Browser inspection (Chrome @ 1200×937), source code analysis (`App.jsx`, `styles.css`)  
**Status:** Issue #1 — Fixed ✅ | Issues #2–#7 — Unfixed, awaiting prioritization

---

## Issue #1 — Connect Button Text is Crushed / Invisible

**Severity:** 🔴 Critical  
**Screen:** Home → Receive card  
**Elements involved:** `.code-input-group`, `.code-input`, `.btn-primary` (Connect)

### Description

The **"Connect" button** in the Receive card is rendered at only **40 px wide**, while its text content requires **96 px**. The button text ("Connect") is completely hidden by `overflow: hidden` inherited from the `.btn` base class.

### Measured values

| Property | Value |
|---|---|
| `.code-input-group` width | 260 px (`max-width: 260px`) |
| `.code-input` rendered width | 244 px (`flex: 1`) |
| Connect button rendered width | **40 px** |
| Connect button scroll width | **96 px** (content needs this much) |
| Button `overflow` | `hidden` |
| Button `white-space` | `nowrap` |

### Root cause

The `.code-input-group` is a flex row constrained to `max-width: 260px`. The `.code-input` has `flex: 1 1 0%` which causes it to consume virtually all available space. After the 8 px gap, only ~8 px remains for the button — but due to minimum intrinsic sizing, the button gets 40 px. This is still far short of the 96 px needed to display "Connect".

### CSS trace

```css
/* styles.css */
.code-input-group {
  display: flex;
  gap: var(--space-2);        /* 8px */
  max-width: 260px;
}

.code-input {
  flex: 1;                    /* ← takes all space, leaves nothing for button */
}

.btn {
  overflow: hidden;           /* ← clips the text */
  white-space: nowrap;        /* ← prevents wrapping, but text is just hidden */
}
```

### Suggested fix

- Give the Connect button a `flex-shrink: 0` so it never shrinks below its content size.
- Or set a `min-width` on the button (e.g. `min-width: 96px`).
- Or reduce the input's `flex-grow` and give the button `flex-shrink: 0; min-width: fit-content`.

---

## Issue #2 — Cards Forced to Equal Height, Creating Awkward Empty Space

**Severity:** 🟡 Medium  
**Screen:** Home → Send & Receive cards grid  
**Elements involved:** `.home-grid`, `.home-card`

### Description

The two-column CSS Grid (`grid-template-columns: 1fr 1fr`) stretches both cards to the **same height**. The Receive card's actual content is ~170 px tall, but it is forced to 417 px to match the Send card (which contains the tall drop zone). This leaves approximately **250 px of dead space** at the bottom of the Receive card, making it look unbalanced.

### Measured values

| Property | Value |
|---|---|
| Send card height | 417 px |
| Receive card height | 417 px (forced equal) |
| Receive card content height | ~170 px (icon + heading + paragraph + input) |
| Unused space in Receive card | ~247 px |

### Root cause

CSS Grid defaults to `align-items: stretch`, which forces grid items to fill the row height.

### Suggested fix

- Set `.home-grid { align-items: start; }` to let each card size to its own content.
- Or set `.home-grid { align-items: start; }` and add a consistent `min-height` to both cards for visual balance.

---

## Issue #3 — File Action Buttons Lack Width Constraints & Visual Hierarchy

**Severity:** 🟡 Medium  
**Screen:** Home → Send card → After files are selected  
**Elements involved:** `.file-actions`, `.btn-ghost`, `.btn-primary`

### Description

When files are selected, three buttons appear: **"Add More"** (ghost), **"Clear"** (ghost), and **"Get Code"** (primary). The `.file-actions` container uses `flex-wrap: wrap` but the individual buttons have no `min-width`. On narrow screens or with many files, the buttons can wrap into an uneven arrangement (e.g., 2 + 1) that looks messy.

Additionally, the "Get Code" primary button doesn't visually dominate enough when stacked with the ghost buttons — the green fill is small and can look similar to the bordered ghost buttons at a glance.

### Relevant CSS

```css
.file-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
  flex-wrap: wrap;
  /* No min-width on children */
}
```

### Suggested fix

- Give `.file-actions .btn-primary` a `min-width` (e.g., `140px`) so it always stands out.
- Consider using `flex-wrap: nowrap` with `overflow: visible` for the action row, or use a dedicated layout where "Get Code" is on its own line.
- Add a `width: 100%` to the primary button when wrapped below a certain breakpoint.

---

## Issue #4 — Back Button is Left-Aligned While All Other Content is Centered

**Severity:** 🟡 Medium  
**Screen:** Send view & Receive view → `← Back` button  
**Elements involved:** `.back-btn`, `.transfer-panel`

### Description

The `← Back` button in both the Send and Receive views has only `margin-top: var(--space-8)` defined. It renders as a block-level element with default `text-align: start`, meaning it sits **flush left**. Every other element in the transfer views — the code display, progress bars, connection badges, and the "Download All" button — is centered. This creates a visual inconsistency.

### Relevant CSS

```css
.back-btn {
  margin-top: var(--space-8);
  /* No text-align, no alignment specified */
}
```

### Suggested fix

- Add `text-align: center` to `.transfer-panel` or `.back-btn`.
- Or wrap the back button in a centered flex container.

---

## Issue #5 — "Download All" Button Uses Inline Styles Instead of Design System

**Severity:** 🟠 Low  
**Screen:** Receive view → After all files are received  
**Elements involved:** Download All button container (inline `style` prop)

### Description

The "Download All" button container uses **inline styles** rather than CSS classes:

```jsx
<motion.div
  style={{ marginTop: "1rem", display: "flex", justifyContent: "center" }}
>
```

This bypasses the app's design token system:
- Uses `"1rem"` instead of `var(--space-4)` (breaking the 8 pt grid).
- Won't respond to responsive media queries defined in `styles.css`.
- Creates inconsistency with how other buttons are styled (all others use CSS classes).

### Suggested fix

- Create a `.download-all-actions` CSS class using design tokens.
- Move the inline styles to that class.

---

## Issue #6 — Mobile Code Input Group Stacks Poorly at ≤480 px

**Severity:** 🟠 Low  
**Screen:** Receive card at ≤480 px width  
**Elements involved:** `.code-input-group`, `.code-input`

### Description

At the 480 px breakpoint, the code input group changes to a vertical stack:

```css
@media (max-width: 480px) {
  .code-input-group {
    flex-direction: column;
    max-width: 200px;
  }
}
```

Issues:
1. The `max-width: 200px` is arbitrary — it doesn't correspond to any spacing variable.
2. The `.code-input` with `letter-spacing: 0.18em` and `text-align: center` becomes cramped at 200 px for a 6-character code.
3. The Connect button becomes full-width at 200 px, which is fine, but the overall group is narrower than the card padding would suggest.

### Suggested fix

- Use a value derived from spacing tokens (e.g., `max-width: var(--space-50)` or a dedicated token).
- Consider increasing to `240px` or `260px` even in column mode to give the input room.
- Ensure the code input font-size scales down at this breakpoint.

---

## Issue #7 — Error Message Causes Layout Shift Inside Receive Card

**Severity:** 🟠 Low  
**Screen:** Receive card → After an invalid code error  
**Elements involved:** `.error-msg` (inside `.receive-card`), `.home-grid`

### Description

When a user enters an invalid code and the error message appears inside the Receive card, it adds ~50 px of content. Because the card is in a grid that forces equal heights (see Issue #2), the error either:
- Pushes the existing content (icon, heading, input) upward, creating a visible **jump**.
- Or, if the card is already at its max height, the error overflows or gets clipped.

The error uses `<AnimatePresence>` with `motion.div` animation, which can amplify the visual jump as the error slides in.

### Relevant JSX

```jsx
<AnimatePresence>
  {error && status === "error" && view === "home" && (
    <motion.div className="error-msg" ...>
      {error}
    </motion.div>
  )}
</AnimatePresence>
```

### Suggested fix

- Reserve space for the error message (e.g., `min-height` on a placeholder element) so the layout doesn't shift.
- Or move the error outside the card grid to avoid height conflicts.
- Or use `align-items: start` on `.home-grid` (fixes Issue #2 as well) so cards can grow independently.

---

## Summary Table

| # | Issue | Severity | Screen | Primary Element |
|---|---|---|---|---|
| ~~1~~ | ~~Connect button text hidden (crushed to 40 px)~~ | ~~🔴 Critical~~ ✅ Fixed | Home → Receive | `.code-input-group` restyled to column layout |
| 2 | Cards forced equal height — dead space in Receive card | 🟡 Medium | Home → Grid | `.home-grid` |
| 3 | File action buttons wrap unevenly, no visual hierarchy | 🟡 Medium | Home → Send (files selected) | `.file-actions` |
| 4 | Back button left-aligned, inconsistent with centered layout | 🟡 Medium | Send / Receive views | `.back-btn` |
| 5 | "Download All" uses inline styles, bypasses design tokens | 🟠 Low | Receive → Complete | Download All `<motion.div>` |
| 6 | Mobile code input cramped at 200 px max-width | 🟠 Low | Receive card ≤480 px | `.code-input-group` |
| 7 | Error message causes layout shift in Receive card | 🟠 Low | Home → Receive (error) | `.error-msg` |

---

## Recommended Fix Order

1. **Issue #1** — Users cannot see or meaningfully click the Connect button.
2. **Issue #2** — Fixes both the empty space problem and mitigates Issue #7.
3. **Issue #4** — Quick alignment fix for visual consistency.
4. **Issue #3** — Improves usability when files are selected.
5. **Issue #5** — Small cleanup for code consistency.
6. **Issue #6** — Minor mobile polish.
7. **Issue #7** — Mitigated by fixing Issue #2; remaining work is minor.
