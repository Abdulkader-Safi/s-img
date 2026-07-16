// s-img: pure TypeScript image manipulation for Node and Bun.
//
// Empty on purpose. The first feature branch (feat/raw-image) exports RawImage
// from here. See features/index.md for the ordered plan.
//
// ponytail: no barrel of empty modules. Each branch adds its own export when it
// has something to export. A barrel that eagerly imports every codec would also
// foreclose the sub-path exports that features/bundle-size.md wants left possible.

export {};
