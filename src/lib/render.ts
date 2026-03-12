import type { Bounds, PatternDocument, PatternRegion } from './types';

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const normalizeCrop = (
  pattern: PatternDocument,
  crop?: Bounds
): Bounds => crop ?? { x: 0, y: 0, width: pattern.width, height: pattern.height };

const regionIntersectsCrop = (region: PatternRegion, crop: Bounds) => {
  const right = region.bbox.x + region.bbox.width;
  const bottom = region.bbox.y + region.bbox.height;
  return !(
    right < crop.x ||
    region.bbox.x > crop.x + crop.width ||
    bottom < crop.y ||
    region.bbox.y > crop.y + crop.height
  );
};

export const getRegionFontSize = (region: PatternRegion) =>
  Math.max(2.9, Math.min(11, region.labelRadius * 1.55));

export const renderReferenceCanvas = (
  pattern: PatternDocument,
  scale = 4,
  crop?: Bounds
) => {
  const activeCrop = normalizeCrop(pattern, crop);
  const sourceCanvas = createCanvas(activeCrop.width, activeCrop.height);
  const sourceContext = sourceCanvas.getContext('2d');

  if (!sourceContext) {
    throw new Error('2D canvas is unavailable in this browser.');
  }

  const imageData = sourceContext.createImageData(
    activeCrop.width,
    activeCrop.height
  );

  for (let y = 0; y < activeCrop.height; y += 1) {
    for (let x = 0; x < activeCrop.width; x += 1) {
      const sourceIndex = (activeCrop.y + y) * pattern.width + (activeCrop.x + x);
      const paletteEntry = pattern.palette[pattern.pixels[sourceIndex]];
      const targetIndex = (y * activeCrop.width + x) * 4;
      imageData.data[targetIndex] = paletteEntry.rgb[0];
      imageData.data[targetIndex + 1] = paletteEntry.rgb[1];
      imageData.data[targetIndex + 2] = paletteEntry.rgb[2];
      imageData.data[targetIndex + 3] = 255;
    }
  }

  sourceContext.putImageData(imageData, 0, 0);

  const outputCanvas = createCanvas(
    activeCrop.width * scale,
    activeCrop.height * scale
  );
  const outputContext = outputCanvas.getContext('2d');

  if (!outputContext) {
    throw new Error('2D canvas is unavailable in this browser.');
  }

  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(
    sourceCanvas,
    0,
    0,
    outputCanvas.width,
    outputCanvas.height
  );

  return outputCanvas;
};

export const renderOutlineCanvas = (
  pattern: PatternDocument,
  scale = 4,
  crop?: Bounds
) => {
  const activeCrop = normalizeCrop(pattern, crop);
  const canvas = createCanvas(activeCrop.width * scale, activeCrop.height * scale);
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('2D canvas is unavailable in this browser.');
  }

  context.fillStyle = '#fffdf8';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.translate(-activeCrop.x, -activeCrop.y);
  context.strokeStyle = '#1e1813';
  context.lineWidth = 0.55;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  for (const region of pattern.regions) {
    if (!regionIntersectsCrop(region, activeCrop) || !region.path) {
      continue;
    }

    context.stroke(new Path2D(region.path));
  }

  context.fillStyle = '#1e1813';
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  for (const region of pattern.regions) {
    if (!regionIntersectsCrop(region, activeCrop)) {
      continue;
    }

    context.font = `600 ${getRegionFontSize(region)}px Georgia, serif`;
    context.fillText(
      String(region.paletteNumber),
      region.label.x,
      region.label.y
    );
  }

  return canvas;
};

export const canvasToPngBytes = async (canvas: HTMLCanvasElement) => {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
        return;
      }

      reject(new Error('Canvas export failed.'));
    }, 'image/png');
  });

  return new Uint8Array(await blob.arrayBuffer());
};
