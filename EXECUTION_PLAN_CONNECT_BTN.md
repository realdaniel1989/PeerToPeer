# Execution Plan - Fix Connect Button (Issue #1)

**Target file:** `client/src/styles.css`
**Status:** ✅ Applied & Verified

---

## Problem Recap

The "Connect" button inside `.code-input-group` is crushed to **40 px** wide while its text content needs **96 px**. The `.code-input` (`flex: 1`) consumes all available space, leaving nothing for the button.

```
code-input-group (260px max-width, flex row)
  ├── code-input: flex: 1 → takes 244px
  └── Connect btn: gets only 40px → needs 96px → TEXT HIDDEN
```

---

## Solution Applied

Changed `.code-input-group` from a horizontal flex row to a **vertical column** layout, with both the code input and Connect button set to `width: 100%` (matching the group's 260px max-width). Removed the now-redundant 480px mobile breakpoint.

```css
.code-input-group {
  flex-direction: column;
  max-width: 260px;
}

.code-input-group .code-input {
  width: 100%;
}

.code-input-group .btn-primary {
  width: 100%;
}
```

**Before:** Input (244px) and button (40px, text hidden) crammed side-by-side in 260px.
**After:** Both input and button are 260px wide, stacked vertically, text fully visible.
