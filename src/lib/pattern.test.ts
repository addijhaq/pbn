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
