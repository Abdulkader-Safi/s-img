// s-img: pure TypeScript image manipulation for Node and Bun.
//
// See features/index.md for the ordered plan. Each branch adds its own export here
// when it has something to export -- no barrel of empty modules, and nothing that
// eagerly imports every codec, which would foreclose the sub-path exports
// features/bundle-size.md wants left possible.

export {
  SImgError,
  CorruptImageError,
  InvalidOptionError,
  UnsupportedFormatError,
  type SImgErrorCode,
} from './core/errors.ts';

export { createImage, assertValidImage, copyImage, type RawImage, type RGBA } from './core/image.ts';
