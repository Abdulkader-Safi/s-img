# flip()

**Milestone 2. Depends on: [raw-image.md](raw-image.md).**

## What it is

Mirror the image. Two independent booleans, exact, no resampling, dimensions unchanged.

```typescript
interface FlipOptions {
  horizontal?: boolean;  // mirror left-right, across the vertical axis
  vertical?: boolean;    // mirror top-bottom, across the horizontal axis
}
```

Both true is a 180° rotation. That is a mathematical fact, not a special case to code —
though it does mean the tests can cross-check `flip({h:true,v:true})` against
`rotate(180)` and catch an axis mix-up for free.

Naming: `horizontal: true` means a **horizontal flip**, i.e. left becomes right. This is the
one place every image library confuses everyone, because "horizontal flip" describes the
direction of motion while the *axis* of reflection is vertical. Match the plugin's existing
UI labels exactly and put a comment on the field. Do not be clever.

## Implementation

- **Vertical flip:** reverse the row order. Copy whole rows with `.set()`, one memcpy per
  row, cheap and cache-friendly.
- **Horizontal flip:** reverse pixel order within each row. Per-pixel (4-byte) swaps, no
  memcpy shortcut.
- **Both:** one pass doing both, not two passes. Trivially, and it halves the memory
  traffic.
- **Neither:** return unchanged. Not an error — the plugin will pass
  `{horizontal: false, vertical: false}` when the user has toggled nothing, and that should
  be a cheap no-op, not a throw.

## Where it sits

Third in the canonical order: crop → rotate → **flip** → resize → format.

The order matters and is not arbitrary. Flip-then-rotate and rotate-then-flip give
different results for any non-180 angle (they do not commute — reflection composed with
rotation is a rotation in the opposite direction). The plugin fixes the order at
rotate-then-flip, so the library enforces the same, regardless of chain call order. See
[pipeline-order.md](pipeline-order.md).

## Use cases

- The plugin's flip buttons.
- Correcting a mirrored selfie or a scan fed in backwards.
- Cross-checking the rotate tests, as above.

## Edge cases

- **1×1.** No-op under both flags.
- **Odd widths** on a horizontal flip: the centre column maps to itself. A swap loop that
  runs to `width / 2` handles this correctly by accident; one that runs to
  `Math.ceil(width / 2)` swaps the centre pixel with itself, which is harmless but wasteful,
  and one that mishandles the bound double-swaps and undoes the flip. Fixture an odd width
  (5) and an even one (4).
- **Both flags on a square image** must equal `rotate(180)` exactly. Free test.

## Acceptance

- Horizontal flip of a 4×1 fixture `[A,B,C,D]` yields `[D,C,B,A]`.
- Horizontal flip of a 5×1 fixture `[A,B,C,D,E]` yields `[E,D,C,B,A]` (the odd-width case).
- Vertical flip of a 1×3 yields the reversed column.
- Flipping twice on either axis is byte-identical to the input.
- `flip({horizontal: true, vertical: true})` is byte-identical to `rotate(180)`.
- `flip({})` returns an image identical to the input.
