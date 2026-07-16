# Examples

Runnable scripts, not tests. Each one does something real and prints what it did.

```bash
npm run example          # the tour: every feature, end to end
npm run example:preview  # the two-pass preview design, with timings
```

They write into `examples/output/`, which is gitignored. Open the files and look at them --
that is the point. A test asserts that a pixel is 128; an example lets you see the picture.

| Script       | What it shows                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `tour.ts`    | The whole API a consumer touches: read, chain, convert, save a reusable spec, handle errors.                                    |
| `preview.ts` | The design the library exists for: decode a preview once, transform it per interaction, decode at full resolution only on save. |
