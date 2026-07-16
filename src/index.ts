// safi-image: pure TypeScript image manipulation for Node and Bun.
//
// See features/index.md for the ordered plan. Each branch adds its own export here
// when it has something to export -- no barrel of empty modules, and nothing that
// eagerly imports every codec, which would foreclose the sub-path exports
// features/bundle-size.md wants left possible.

export {
  SImgError,
  CorruptImageError,
  ImageTooLargeError,
  InvalidOptionError,
  UnsupportedFormatError,
  type SImgErrorCode,
} from './core/errors.ts';

export {
  createImage,
  assertValidImage,
  copyImage,
  DEFAULT_MAX_PIXELS,
  type RawImage,
  type RGBA,
} from './core/image.ts';

export { FORMATS, sniff, type Format } from './core/formats.ts';
export { supportedFormats, type FormatSupport } from './core/supported.ts';
export { decode, encode, preload, probe, type DecodeOptions, type FormatOptions } from './core/dispatch.ts';
export { SImg, SImgChain, Pipeline } from './core/simg.ts';
// The fs boundary. Kept out of the pixel code, and out of anything a browser build ships.
export { fromFile, toFile } from './io/index.ts';
export { applySpec, validateSpec, type PipelineSpec, type ResizeStage } from './core/pipeline.ts';

// Codec-level entry points. `decode`/`encode` will dispatch to these once they land;
// they stay exported as the low-level door for a caller who already knows the format
// and wants to skip the sniff (features/api-surface.md).
export { decodePng, encodePng, probePng } from './core/codecs/png.ts';
export { decodeBmp, encodeBmp, probeBmp, type BmpEncodeOptions } from './core/codecs/bmp.ts';
export { decodeGif, encodeGif, probeGif, type GifEncodeOptions } from './core/codecs/gif.ts';
export { decodeTiff, encodeTiff, probeTiff, type TiffEncodeOptions } from './core/codecs/tiff.ts';
export {
  decodeJpeg,
  encodeJpeg,
  probeJpeg,
  readExifOrientation,
  type JpegEncodeOptions,
} from './core/codecs/jpeg.ts';

export { crop, type CropOptions } from './core/transform/crop.ts';
export { flip, type FlipOptions } from './core/transform/flip.ts';
export { rotate90 } from './core/transform/rotate90.ts';
export { resize, maxLongEdge, type ResizeOptions } from './core/transform/resize.ts';
export { type Resampling } from './core/transform/resample.ts';
export { rotate, type RotateOptions } from './core/transform/rotate.ts';
