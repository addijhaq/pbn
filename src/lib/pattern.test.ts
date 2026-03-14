import { Buffer } from 'node:buffer';
import { PDFDocument } from 'pdf-lib';
import { buildPdfBytes } from './pdf';
import {
  analyzeSceneMap,
  analyzeImageProfile,
  buildPathString,
  createPatternFromImageData,
  mergeSmallRegions,
  quantizeImageData,
  sampleSceneScore,
  simplifyContourLoop,
  smoothPixelAssignments
} from './pattern';
import type { PatternDocument } from './types';

const createImageData = (
  width: number,
  height: number,
  colorAt: (x: number, y: number) => [number, number, number]
) => {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const [red, green, blue] = colorAt(x, y);
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }

  return {
    data,
    width,
    height
  } as ImageData;
};

describe('quantizeImageData', () => {
  it('reduces an image to the requested palette size', () => {
    const imageData = createImageData(18, 18, (x, y) => [
      (x * 11) % 256,
      (y * 13) % 256,
      ((x + y) * 17) % 256
    ]);

    const quantized = quantizeImageData(imageData, {
      paletteSize: 8,
      workingMaxDimension: 280,
      minRegionPixels: 1,
      maxKMeansIterations: 10,
      maxDetailPages: 4,
      detailGrid: 3,
      targetRegionCount: 80,
      cleanupStrength: 0.4
    });

    expect(quantized.palette).toHaveLength(8);
    expect(Math.max(...quantized.pixels)).toBeLessThan(8);
  });

  it('preserves minority accent greens and bright line colors in illustrative art', () => {
    const imageData = createImageData(24, 24, (x, y) => {
      if (x >= 8 && x <= 15 && y >= 7 && y <= 20) {
        if ((x === 11 || x === 12) && y >= 10 && y <= 18) {
          return [244, 241, 232];
        }

        return [20, 20, 24];
      }

      if (y <= 5 && (x <= 7 || x >= 16)) {
        return [187, 118, 150];
      }

      if (y >= 16 && x <= 8) {
        return x <= 4 ? [94, 104, 57] : [130, 144, 86];
      }

      if (y >= 16 && x >= 15) {
        return x >= 19 ? [94, 104, 57] : [130, 144, 86];
      }

      return [206, 194, 166];
    });
    const profile = analyzeImageProfile(imageData, 8);
    const quantized = quantizeImageData(
      imageData,
      {
        paletteSize: 8,
        workingMaxDimension: 280,
        minRegionPixels: 1,
        maxKMeansIterations: 12,
        maxDetailPages: 4,
        detailGrid: 3,
        targetRegionCount: 80,
        cleanupStrength: 0.35
      },
      profile
    );
    const greenEntries = quantized.palette.filter(
      (entry) => entry.rgb[1] >= entry.rgb[0] + 8 && entry.rgb[1] >= entry.rgb[2] + 4
    );
    const brightEntries = quantized.palette.filter(
      (entry) => entry.rgb[0] >= 228 && entry.rgb[1] >= 228 && entry.rgb[2] >= 220
    );

    expect(greenEntries.length).toBeGreaterThanOrEqual(2);
    expect(brightEntries.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buildPathString', () => {
  it('rounds orthogonal corners with bezier curves', () => {
    const path = buildPathString([[
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 }
    ]]);

    expect(path).toContain('Q');
    expect(path.startsWith('M')).toBe(true);
  });
});

describe('simplifyContourLoop', () => {
  it('reduces staircase contours before bezier smoothing', () => {
    const staircase = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
      { x: 6, y: 5 },
      { x: 0, y: 5 }
    ];

    const simplified = simplifyContourLoop(staircase);

    expect(simplified.length).toBeLessThan(staircase.length);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
  });
});

describe('analyzeSceneMap', () => {
  it('scores line-heavy tiles as more structural than soft tiles', () => {
    const imageData = createImageData(24, 12, (x) => {
      if (x < 12) {
        return Math.floor(x / 3) % 2 === 0
          ? [20, 20, 20]
          : [245, 245, 245];
      }

      return [190, 190, 190];
    });

    const sceneMap = analyzeSceneMap(imageData);
    const structuralScore = sampleSceneScore(sceneMap, 4, 6);
    const softScore = sampleSceneScore(sceneMap, 20, 6);

    expect(structuralScore).toBeGreaterThan(softScore + 0.2);
  });
});

describe('analyzeImageProfile', () => {
  it('detects monochrome artwork and reduces the effective palette size', () => {
    const imageData = createImageData(18, 18, (x, y) =>
      x < 9 || y < 9 ? [12, 12, 12] : [244, 244, 244]
    );

    const profile = analyzeImageProfile(imageData, 12);

    expect(profile.monochromeScore).toBeGreaterThan(0.7);
    expect(profile.renderingMode).toBe('artwork');
    expect(profile.effectivePaletteSize).toBeLessThanOrEqual(4);
  });
});

describe('mergeSmallRegions', () => {
  it('absorbs isolated islands into neighboring regions', () => {
    const pixels = new Uint8Array([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0
    ]);

    const merged = mergeSmallRegions(pixels, 3, 3, 2);

    expect([...merged]).toEqual([
      0, 0, 0,
      0, 0, 0,
      0, 0, 0
    ]);
  });
});

describe('smoothPixelAssignments', () => {
  it('replaces isolated noisy pixels with the local dominant color', () => {
    const pixels = new Uint8Array([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0
    ]);

    const smoothed = smoothPixelAssignments(pixels, 3, 3, 0.6);

    expect([...smoothed]).toEqual([
      0, 0, 0,
      0, 0, 0,
      0, 0, 0
    ]);
  });
});

describe('createPatternFromImageData', () => {
  it('creates labeled regions with printable geometry', () => {
    const imageData = createImageData(12, 12, (x, y) => {
      if (x < 6) {
        return [220, 86, 62];
      }

      if (y < 6) {
        return [246, 196, 93];
      }

      return [72, 138, 180];
    });

    const pattern = createPatternFromImageData(imageData, {
      paletteSize: 3,
      minRegionPixels: 2,
      targetRegionCount: 12
    });

    expect(pattern.regions.length).toBeGreaterThanOrEqual(3);

    for (const region of pattern.regions) {
      expect(region.path.length).toBeGreaterThan(0);
      expect(region.label.x).toBeGreaterThanOrEqual(region.bbox.x);
      expect(region.label.x).toBeLessThanOrEqual(region.bbox.x + region.bbox.width);
      expect(region.label.y).toBeGreaterThanOrEqual(region.bbox.y);
      expect(region.label.y).toBeLessThanOrEqual(region.bbox.y + region.bbox.height);
    }
  });

  it('keeps low-color artwork to the colors actually used in the final pattern', () => {
    const imageData = createImageData(15, 15, (x, y) => {
      if (x < 5) {
        return [18, 18, 18];
      }

      if (y < 8) {
        return [252, 252, 252];
      }

      return [214, 44, 58];
    });

    const pattern = createPatternFromImageData(imageData, {
      paletteSize: 12,
      minRegionPixels: 1,
      targetRegionCount: 32,
      cleanupStrength: 0.4
    });
    const paletteNumbers = [...new Set(pattern.regions.map((region) => region.paletteNumber))]
      .sort((left, right) => left - right);

    expect(pattern.palette).toHaveLength(3);
    expect(paletteNumbers).toEqual([1, 2, 3]);
  });

  it('flattens textured artwork backgrounds while preserving bright linework', () => {
    const imageData = createImageData(28, 28, (x, y) => {
      const backgroundShift = ((x * 3 + y * 5) % 4) * 4;
      const background: [number, number, number] = [
        46 + backgroundShift,
        48 + backgroundShift,
        58 + backgroundShift
      ];
      const dx = (x - 14) / 8.2;
      const dy = (y - 13) / 7;
      const insideBody = dx * dx + dy * dy <= 1;
      const tailDx = (x - 16) / 4.5;
      const tailDy = (y - 20) / 5.2;
      const insideTail = tailDx * tailDx + tailDy * tailDy <= 1;
      const insideFox = insideBody || insideTail;
      const stitch =
        insideFox &&
        (((x + y) % 5 === 0 && y >= 7 && y <= 21) ||
          (Math.abs(x - 14) <= 1 && y >= 8 && y <= 18) ||
          (Math.abs(y - 12) <= 1 && x >= 8 && x <= 19));

      if (stitch) {
        return [242, 240, 228];
      }

      if (insideFox) {
        return [60, 60, 68];
      }

      return background;
    });

    const pattern = createPatternFromImageData(imageData, {
      paletteSize: 8,
      minRegionPixels: 1,
      targetRegionCount: 120,
      cleanupStrength: 0.4
    });
    const borderPalette = new Set<number>();

    for (let y = 0; y < pattern.height; y += 1) {
      for (let x = 0; x < pattern.width; x += 1) {
        if (x === 0 || y === 0 || x === pattern.width - 1 || y === pattern.height - 1) {
          borderPalette.add(pattern.pixels[y * pattern.width + x]);
        }
      }
    }

    const lightestPaletteIndex = pattern.palette.reduce(
      (bestIndex, entry, index) =>
        entry.lightness > pattern.palette[bestIndex].lightness ? index : bestIndex,
      0
    );
    let lightStrokePixels = 0;

    for (const pixel of pattern.pixels) {
      if (pixel === lightestPaletteIndex) {
        lightStrokePixels += 1;
      }
    }

    expect(borderPalette.size).toBe(1);
    expect(borderPalette.has(lightestPaletteIndex)).toBe(false);
    expect(lightStrokePixels).toBeGreaterThanOrEqual(12);
  });

  it('preserves bright interior linework in colorful illustration subjects', () => {
    const imageData = createImageData(28, 28, (x, y) => {
      const background: [number, number, number] = [227, 216, 190];
      const dxLeft = (x - 9) / 4.8;
      const dyLeft = (y - 14) / 7.5;
      const dxRight = (x - 19) / 4.8;
      const dyRight = (y - 14) / 7.5;
      const insideBird = dxLeft * dxLeft + dyLeft * dyLeft <= 1 || dxRight * dxRight + dyRight * dyRight <= 1;
      const wingLine =
        ((x >= 7 && x <= 11 && Math.abs(y - (x + 6)) <= 1) ||
          (x >= 17 && x <= 21 && Math.abs(y - (-x + 32)) <= 1)) &&
        y >= 10 &&
        y <= 21;
      const eyeAndBeak =
        ((x === 10 || x === 18) && y === 10) ||
        ((x >= 11 && x <= 13) && y === 11) ||
        ((x >= 15 && x <= 17) && y === 11);
      const flower =
        y <= 6 && ((x >= 3 && x <= 7) || (x >= 20 && x <= 24));
      const leaf =
        y >= 17 && ((x >= 5 && x <= 9) || (x >= 18 && x <= 22));

      if (wingLine || eyeAndBeak) {
        return [243, 240, 227];
      }

      if (insideBird) {
        return [24, 24, 26];
      }

      if (flower) {
        return [201, 130, 162];
      }

      if (leaf) {
        return [119, 123, 76];
      }

      return background;
    });

    const pattern = createPatternFromImageData(imageData, {
      paletteSize: 8,
      minRegionPixels: 1,
      targetRegionCount: 180,
      cleanupStrength: 0.2
    });
    const maxLightness = Math.max(...pattern.palette.map((entry) => entry.lightness));
    const brightIndices = pattern.palette
      .filter((entry) => entry.lightness >= maxLightness - 6)
      .map((entry) => entry.index);
    const strokeSamplePoints = [
      { x: 8, y: 14 },
      { x: 10, y: 16 },
      { x: 18, y: 14 },
      { x: 20, y: 12 },
      { x: 10, y: 10 },
      { x: 18, y: 10 }
    ];
    let brightPixelCount = 0;
    let preservedStrokeSamples = 0;

    for (const pixel of pattern.pixels) {
      if (brightIndices.includes(pixel)) {
        brightPixelCount += 1;
      }
    }

    for (const point of strokeSamplePoints) {
      const paletteIndex = pattern.pixels[point.y * pattern.width + point.x];

      if (brightIndices.includes(paletteIndex)) {
        preservedStrokeSamples += 1;
      }
    }

    expect(brightIndices.length).toBeGreaterThanOrEqual(1);
    expect(brightPixelCount).toBeGreaterThanOrEqual(24);
    expect(preservedStrokeSamples).toBeGreaterThanOrEqual(4);
  });

  it('keeps multiple green leaf shades in illustrative palettes alongside floral accents', () => {
    const imageData = createImageData(34, 34, (x, y) => {
      const background: [number, number, number] = [227, 216, 190];
      const leftBird =
        ((x - 11) / 5.2) ** 2 + ((y - 15) / 8.6) ** 2 <= 1;
      const rightBird =
        ((x - 23) / 5.2) ** 2 + ((y - 15) / 8.6) ** 2 <= 1;
      const wingLine =
        (((x >= 9 && x <= 13) && Math.abs(y - (x + 5)) <= 1) ||
          ((x >= 21 && x <= 25) && Math.abs(y - (-x + 36)) <= 1)) &&
        y >= 11 &&
        y <= 24;
      const centralLeaf =
        y >= 14 &&
        y <= 27 &&
        Math.abs(x - 17) <= Math.max(1, Math.floor((27 - y) / 4));
      const lowerLeafShadow =
        y >= 22 &&
        ((x >= 6 && x <= 11) || (x >= 22 && x <= 27));
      const lowerLeafHighlight =
        y >= 20 &&
        y <= 26 &&
        ((x >= 8 && x <= 12) || (x >= 21 && x <= 25));
      const flower =
        y <= 8 &&
        (((x >= 3 && x <= 9) && (x + y) % 2 === 0) ||
          ((x >= 24 && x <= 30) && (x + y) % 2 === 0));

      if (wingLine) {
        return [243, 240, 227];
      }

      if (leftBird || rightBird) {
        return [24, 24, 26];
      }

      if (flower) {
        return x % 3 === 0 ? [205, 129, 163] : [187, 109, 145];
      }

      if (centralLeaf || lowerLeafHighlight) {
        return [133, 141, 88];
      }

      if (lowerLeafShadow) {
        return [94, 104, 57];
      }

      return background;
    });

    const pattern = createPatternFromImageData(imageData, {
      paletteSize: 8,
      minRegionPixels: 1,
      targetRegionCount: 180,
      cleanupStrength: 0.2
    });
    const greenEntries = pattern.palette.filter(
      (entry) =>
        entry.rgb[1] >= entry.rgb[0] + 8 && entry.rgb[1] >= entry.rgb[2] + 2
    );
    const greenLightnesses = greenEntries
      .map((entry) => entry.lightness)
      .sort((left, right) => left - right);

    expect(greenEntries.length).toBeGreaterThanOrEqual(2);
    expect(
      greenLightnesses[greenLightnesses.length - 1] - greenLightnesses[0]
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('region convergence', () => {
  it('caps noisy checkerboards to a manageable region count', () => {
    const imageData = createImageData(20, 20, (x, y) =>
      (x + y) % 2 === 0 ? [230, 70, 60] : [72, 138, 180]
    );

    const pattern = createPatternFromImageData(imageData, {
      paletteSize: 2,
      minRegionPixels: 1,
      targetRegionCount: 8,
      cleanupStrength: 1
    });

    expect(pattern.regions.length).toBeLessThanOrEqual(8);
  });
});

describe('buildPdfBytes', () => {
  it('creates a workbook PDF with the expected page count', async () => {
    const pattern: PatternDocument = {
      width: 10,
      height: 10,
      originalWidth: 100,
      originalHeight: 100,
      palette: Array.from({ length: 20 }, (_, index) => ({
        index,
        number: index + 1,
        rgb: [20 + index, 40 + index, 60 + index] as [number, number, number],
        hex: '#123456',
        label: `Color ${index + 1}`,
        lightness: index,
        usage: 0.05
      })),
      pixels: new Uint8Array(100),
      regions: [
        {
          id: 1,
          paletteIndex: 0,
          paletteNumber: 1,
          pixelCount: 100,
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          label: { x: 5, y: 5 },
          labelRadius: 3,
          loops: [[
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 }
          ]],
          path: 'M0 0 L10 0 L10 10 L0 10 Z'
        }
      ],
      detailWindows: [
        {
          id: 'detail-1',
          title: 'Detail A',
          x: 0,
          y: 0,
          width: 5,
          height: 5,
          regionCount: 1
        }
      ]
    };

    const pngBytes = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAucB9sV4n4sAAAAASUVORK5CYII=',
        'base64'
      )
    );

    const bytes = await buildPdfBytes(
      pattern,
      {
        referencePng: pngBytes,
        detailPngs: {
          'detail-1': pngBytes
        }
      },
      {
        pageSize: 'letter'
      }
    );

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(4);
  });
});
