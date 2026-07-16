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

export { FORMATS, type Format } from './core/formats.ts';

// Codec-level entry points. `decode`/`encode` will dispatch to these once they land;
// they stay exported as the low-level door for a caller who already knows the format
// and wants to skip the sniff (features/api-surface.md).
export { decodePng, encodePng, probePng } from './core/codecs/png.ts';

export { crop, type CropOptions } from './core/transform/crop.ts';
export { flip, type FlipOptions } from './core/transform/flip.ts';
export { rotate90 } from './core/transform/rotate90.ts';
export { resize, maxLongEdge, type ResizeOptions } from './core/transform/resize.ts';
export { type Resampling } from './core/transform/resample.ts';
