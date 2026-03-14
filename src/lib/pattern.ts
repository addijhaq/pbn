import { labDistance, labHue, labToRgb, rgbToHex, rgbToLab } from './color';
import type {
  DetailWindow,
  PatternDocument,
  PatternOptions,
  PaletteEntry,
  PatternRegion,
  Point
} from './types';

const DEFAULT_PATTERN_OPTIONS: PatternOptions = {
  paletteSize: 18,
  workingMaxDimension: 340,
  minRegionPixels: 34,
  maxKMeansIterations: 18,
  maxDetailPages: 6,
  detailGrid: 4,
  targetRegionCount: 650,
  cleanupStrength: 0.42
};

const neighborOffsets = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

const smoothingOffsets = [
  { dx: -1, dy: -1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 }
];

interface Component {
  paletteIndex: number;
  pixelCount: number;
  pixels: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  neighborCounts: Map<number, number>;
}

interface SceneMap {
  cols: number;
  rows: number;
  tileSize: number;
  scores: Float32Array;
}

interface ImageProfile {
  renderingMode: 'photo' | 'artwork';
  effectivePaletteSize: number;
  cleanupStrengthScale: number;
  minRegionScale: number;
  targetRegionScale: number;
  paletteMergeDistance: number;
  flatArtworkScore: number;
  monochromeScore: number;
}

interface QuantizationItem {
  l: number;
  a: number;
  b: number;
  weight: number;
  detailScore: number;
}

interface ArtworkHueFamilyStats {
  key: string;
  itemIndices: number[];
  totalWeight: number;
  detailWeightedTotal: number;
  priorityWeightedTotal: number;
  minLightness: number;
  maxLightness: number;
  minChroma: number;
  maxChroma: number;
  meanChroma: number;
}

interface LineworkQuantizedResult {
  palette: PaletteEntry[];
  pixels: Uint8Array;
  strokeMask?: Uint8Array;
  strokePaletteIndex?: number;
}

const keyForPoint = (point: Point) => `${point.x},${point.y}`;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);

const labChroma = (a: number, b: number) => Math.hypot(a, b);

const labHueDegrees = (a: number, b: number) => {
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return hue >= 0 ? hue : hue + 360;
};

const getArtworkHueFamilyKey = (l: number, a: number, b: number) => {
  const chroma = labChroma(a, b);

  if (chroma < 12) {
    if (l < 30) {
      return 'neutral-dark';
    }

    if (l < 68) {
      return 'neutral-mid';
    }

    return 'neutral-light';
  }

  return `hue-${Math.floor(((labHueDegrees(a, b) + 30) % 360) / 60)}`;
};

const formatPathNumber = (value: number) =>
  `${Math.round(value * 1000) / 1000}`;

const distanceBetweenPoints = (first: Point, second: Point) =>
  Math.hypot(second.x - first.x, second.y - first.y);

const triangleAreaTwice = (previous: Point, current: Point, next: Point) =>
  Math.abs(
    (current.x - previous.x) * (next.y - previous.y) -
      (current.y - previous.y) * (next.x - previous.x)
  );

const movePointTowards = (
  from: Point,
  to: Point,
  distance: number
): Point => {
  const length = distanceBetweenPoints(from, to);

  if (length === 0 || distance === 0) {
    return { ...from };
  }

  const ratio = distance / length;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio
  };
};

export const simplifyContourLoop = (loop: Point[]) => {
  if (loop.length < 6) {
    return loop;
  }

  const simplified = [...loop];
  let passesWithoutChange = 0;

  while (simplified.length > 4 && passesWithoutChange < 2) {
    let removedPoint = false;

    for (let index = 0; index < simplified.length; index += 1) {
      const previous =
        simplified[(index - 1 + simplified.length) % simplified.length];
      const current = simplified[index];
      const next = simplified[(index + 1) % simplified.length];
      const incomingLength = distanceBetweenPoints(previous, current);
      const outgoingLength = distanceBetweenPoints(current, next);
      const spanLength = distanceBetweenPoints(previous, next);
      const areaTwice = triangleAreaTwice(previous, current, next);
      const smallTurn =
        areaTwice <= 1.25 &&
        incomingLength <= 2.25 &&
        outgoingLength <= 2.25;
      const shortDogleg =
        areaTwice <= 2.2 &&
        incomingLength + outgoingLength <= 4.25 &&
        spanLength <= 3.6;

      if (smallTurn || shortDogleg) {
        simplified.splice(index, 1);
        removedPoint = true;
        break;
      }
    }

    if (removedPoint) {
      passesWithoutChange = 0;
    } else {
      passesWithoutChange += 1;
    }
  }

  return simplified.length >= 4 ? simplified : loop;
};

const buildRoundedLoopPath = (loop: Point[]) => {
  if (loop.length < 3) {
    return '';
  }

  const corners = loop.map((point, index) => {
    const previous = loop[(index - 1 + loop.length) % loop.length];
    const next = loop[(index + 1) % loop.length];
    const incomingLength = distanceBetweenPoints(previous, point);
    const outgoingLength = distanceBetweenPoints(point, next);
    const radius = Math.min(0.42, incomingLength / 2, outgoingLength / 2);

    return {
      point,
      entry: movePointTowards(point, previous, radius),
      exit: movePointTowards(point, next, radius)
    };
  });

  const firstCorner = corners[0];
  const commands = [
    `M${formatPathNumber(firstCorner.exit.x)} ${formatPathNumber(firstCorner.exit.y)}`
  ];

  for (let index = 1; index < corners.length; index += 1) {
    const corner = corners[index];
    commands.push(
      `L${formatPathNumber(corner.entry.x)} ${formatPathNumber(corner.entry.y)}`,
      `Q${formatPathNumber(corner.point.x)} ${formatPathNumber(corner.point.y)} ${formatPathNumber(corner.exit.x)} ${formatPathNumber(corner.exit.y)}`
    );
  }

  commands.push(
    `L${formatPathNumber(firstCorner.entry.x)} ${formatPathNumber(firstCorner.entry.y)}`,
    `Q${formatPathNumber(firstCorner.point.x)} ${formatPathNumber(firstCorner.point.y)} ${formatPathNumber(firstCorner.exit.x)} ${formatPathNumber(firstCorner.exit.y)}`,
    'Z'
  );

  return commands.join(' ');
};

export const buildPathString = (loops: Point[][]) =>
  loops
    .map((loop) => buildRoundedLoopPath(simplifyContourLoop(loop)))
    .filter(Boolean)
    .join(' ');

const clampDimension = (
  width: number,
  height: number,
  maxDimension: number
) => {
  const ratio = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
};

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const loadFileToImageData = async (
  file: File,
  maxDimension: number
): Promise<{
  imageData: ImageData;
  originalWidth: number;
  originalHeight: number;
}> => {
  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await createImageBitmap(file);
    const workingSize = clampDimension(bitmap.width, bitmap.height, maxDimension);
    const canvas = createCanvas(workingSize.width, workingSize.height);
    const context = canvas.getContext('2d', {
      willReadFrequently: true
    });

    if (!context) {
      throw new Error('2D canvas is unavailable in this browser.');
    }

    context.drawImage(bitmap, 0, 0, workingSize.width, workingSize.height);

    return {
      imageData: context.getImageData(0, 0, workingSize.width, workingSize.height),
      originalWidth: bitmap.width,
      originalHeight: bitmap.height
    };
  } finally {
    bitmap?.close();
  }
};

const computeLabPixels = (imageData: ImageData) => {
  const totalPixels = imageData.width * imageData.height;
  const labs = new Float32Array(totalPixels * 3);

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    const alpha = imageData.data[sourceIndex + 3];
    const red = alpha < 8 ? 255 : imageData.data[sourceIndex];
    const green = alpha < 8 ? 255 : imageData.data[sourceIndex + 1];
    const blue = alpha < 8 ? 255 : imageData.data[sourceIndex + 2];
    const lab = rgbToLab(red, green, blue);
    const offset = pixelIndex * 3;
    labs[offset] = lab.l;
    labs[offset + 1] = lab.a;
    labs[offset + 2] = lab.b;
  }

  return labs;
};

const computeLuminancePixels = (imageData: ImageData) => {
  const totalPixels = imageData.width * imageData.height;
  const luminance = new Float32Array(totalPixels);

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    luminance[pixelIndex] =
      imageData.data[sourceIndex] * 0.299 +
      imageData.data[sourceIndex + 1] * 0.587 +
      imageData.data[sourceIndex + 2] * 0.114;
  }

  return luminance;
};

const cloneImageData = (imageData: ImageData) =>
  ({
    data: new Uint8ClampedArray(imageData.data),
    width: imageData.width,
    height: imageData.height
  }) as ImageData;

const collectBorderPixelIndices = (
  width: number,
  height: number,
  thickness: number
) => {
  const indices: number[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (
        x < thickness ||
        y < thickness ||
        x >= width - thickness ||
        y >= height - thickness
      ) {
        indices.push(y * width + x);
      }
    }
  }

  return indices;
};

export const analyzeSceneMap = (imageData: ImageData): SceneMap => {
  const tileSize = clamp(
    Math.round(Math.max(imageData.width, imageData.height) / 22),
    8,
    18
  );
  const cols = Math.ceil(imageData.width / tileSize);
  const rows = Math.ceil(imageData.height / tileSize);
  const scores = new Float32Array(cols * rows);
  const luminance = computeLuminancePixels(imageData);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const startX = column * tileSize;
      const startY = row * tileSize;
      const endX = Math.min(imageData.width - 1, startX + tileSize);
      const endY = Math.min(imageData.height - 1, startY + tileSize);
      let edgeSum = 0;
      let edgeCount = 0;
      let axialEdges = 0;
      let edgePixels = 0;

      for (let y = Math.max(1, startY); y < endY; y += 1) {
        for (let x = Math.max(1, startX); x < endX; x += 1) {
          const pixelIndex = y * imageData.width + x;
          const gx =
            luminance[pixelIndex + 1] - luminance[pixelIndex - 1];
          const gy =
            luminance[pixelIndex + imageData.width] -
            luminance[pixelIndex - imageData.width];
          const absGx = Math.abs(gx);
          const absGy = Math.abs(gy);
          const edgeMagnitude = absGx + absGy;

          edgeSum += edgeMagnitude;
          edgeCount += 1;

          if (edgeMagnitude > 18) {
            edgePixels += 1;
            const dominant = Math.max(absGx, absGy);
            const secondary = Math.min(absGx, absGy);

            if (dominant > secondary * 1.5) {
              axialEdges += 1;
            }
          }
        }
      }

      const averageEdge = edgeCount === 0 ? 0 : edgeSum / edgeCount;
      const edgeStrength = clamp01((averageEdge - 6) / 42);
      const axialRatio = edgePixels === 0 ? 0 : axialEdges / edgePixels;
      const structuralScore = clamp01(edgeStrength * 0.45 + axialRatio * 0.75);

      scores[row * cols + column] = structuralScore;
    }
  }

  return {
    cols,
    rows,
    tileSize,
    scores
  };
};

export const sampleSceneScore = (
  sceneMap: SceneMap,
  x: number,
  y: number
) => {
  const gridX = clamp(x / sceneMap.tileSize - 0.5, 0, sceneMap.cols - 1);
  const gridY = clamp(y / sceneMap.tileSize - 0.5, 0, sceneMap.rows - 1);
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(sceneMap.cols - 1, x0 + 1);
  const y1 = Math.min(sceneMap.rows - 1, y0 + 1);
  const tx = gridX - x0;
  const ty = gridY - y0;
  const index = (column: number, row: number) => row * sceneMap.cols + column;
  const top =
    sceneMap.scores[index(x0, y0)] * (1 - tx) +
    sceneMap.scores[index(x1, y0)] * tx;
  const bottom =
    sceneMap.scores[index(x0, y1)] * (1 - tx) +
    sceneMap.scores[index(x1, y1)] * tx;

  return top * (1 - ty) + bottom * ty;
};

export const analyzeImageProfile = (
  imageData: ImageData,
  requestedPaletteSize: number
): ImageProfile => {
  const totalPixels = imageData.width * imageData.height;
  const sampleStride = Math.max(1, Math.round(Math.sqrt(totalPixels / 5200)));
  const colorBins = new Set<number>();
  let chromaSum = 0;
  let sampleCount = 0;
  let softTransitions = 0;
  let mediumTransitions = 0;
  let hardTransitions = 0;

  for (let y = 0; y < imageData.height; y += sampleStride) {
    for (let x = 0; x < imageData.width; x += sampleStride) {
      const sourceIndex = (y * imageData.width + x) * 4;
      const red = imageData.data[sourceIndex];
      const green = imageData.data[sourceIndex + 1];
      const blue = imageData.data[sourceIndex + 2];
      const lab = rgbToLab(red, green, blue);
      const chroma = Math.hypot(lab.a, lab.b);

      colorBins.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
      chromaSum += chroma;
      sampleCount += 1;

      if (x + sampleStride < imageData.width) {
        const neighborIndex = (y * imageData.width + x + sampleStride) * 4;
        const delta =
          Math.abs(red - imageData.data[neighborIndex]) +
          Math.abs(green - imageData.data[neighborIndex + 1]) +
          Math.abs(blue - imageData.data[neighborIndex + 2]);

        if (delta < 18) {
          softTransitions += 1;
        } else if (delta < 72) {
          mediumTransitions += 1;
        } else {
          hardTransitions += 1;
        }
      }
    }
  }

  const averageChroma = sampleCount === 0 ? 0 : chromaSum / sampleCount;
  const transitionCount =
    softTransitions + mediumTransitions + hardTransitions;
  const softRatio =
    transitionCount === 0 ? 1 : softTransitions / transitionCount;
  const mediumRatio =
    transitionCount === 0 ? 0 : mediumTransitions / transitionCount;
  const hardRatio =
    transitionCount === 0 ? 0 : hardTransitions / transitionCount;
  const lowColorScore = clamp01(
    (requestedPaletteSize + 4 - colorBins.size) /
      Math.max(4, requestedPaletteSize + 2)
  );
  const monochromeScore = clamp01((18 - averageChroma) / 18);
  const flatArtworkScore = clamp01(
    lowColorScore * 0.58 +
      softRatio * 0.16 +
      hardRatio * 0.24 -
      mediumRatio * 0.14
  );
  const renderingMode =
    monochromeScore > 0.76 ||
    flatArtworkScore > 0.42 ||
    (flatArtworkScore > 0.3 && mediumRatio < 0.4 && hardRatio > 0.18)
      ? 'artwork'
      : 'photo';

  let effectivePaletteSize = requestedPaletteSize;

  if (colorBins.size <= requestedPaletteSize + 2) {
    effectivePaletteSize = Math.max(
      2,
      Math.min(requestedPaletteSize, colorBins.size)
    );
  } else if (monochromeScore > 0.72) {
    effectivePaletteSize = Math.max(
      2,
      Math.min(
        requestedPaletteSize,
        4,
        Math.max(2, Math.round(colorBins.size * 0.55))
      )
    );
  } else if (flatArtworkScore > 0.45) {
    effectivePaletteSize = Math.max(
      3,
      Math.min(
        requestedPaletteSize,
        Math.max(3, Math.round(Math.min(colorBins.size, requestedPaletteSize) * 0.82))
      )
    );
  }

  return {
    renderingMode,
    effectivePaletteSize,
    cleanupStrengthScale: clamp(
      1 - flatArtworkScore * 0.42 - monochromeScore * 0.18,
      0.48,
      1
    ),
    minRegionScale: clamp(1 - flatArtworkScore * 0.15, 0.78, 1),
    targetRegionScale: 1 + flatArtworkScore * 0.18 + monochromeScore * 0.08,
    paletteMergeDistance:
      monochromeScore > 0.72 ? 10 : flatArtworkScore > 0.55 ? 7 : 0,
    flatArtworkScore,
    monochromeScore
  };
};

const buildQuantizationItems = (
  labs: Float32Array,
  sampleIndices: number[],
  imageProfile?: ImageProfile,
  detailProtectionMap?: Float32Array
) => {
  if (
    !imageProfile ||
    imageProfile.renderingMode !== 'artwork' ||
    imageProfile.flatArtworkScore < 0.24
  ) {
    return sampleIndices.map((sampleIndex) => {
      const offset = sampleIndex * 3;

      return {
        l: labs[offset],
        a: labs[offset + 1],
        b: labs[offset + 2],
        weight: 1,
        detailScore: detailProtectionMap?.[sampleIndex] ?? 0
      };
    });
  }

  const bins = new Map<
    string,
    { l: number; a: number; b: number; count: number; detailTotal: number }
  >();

  for (const sampleIndex of sampleIndices) {
    const offset = sampleIndex * 3;
    const lightness = labs[offset];
    const greenRed = labs[offset + 1];
    const blueYellow = labs[offset + 2];
    const key = [
      Math.round(lightness / 5),
      Math.round((greenRed + 96) / 9),
      Math.round((blueYellow + 96) / 9)
    ].join(':');
    const existing = bins.get(key);

    if (existing) {
      existing.l += lightness;
      existing.a += greenRed;
      existing.b += blueYellow;
      existing.count += 1;
      existing.detailTotal += detailProtectionMap?.[sampleIndex] ?? 0;
      continue;
    }

    bins.set(key, {
      l: lightness,
      a: greenRed,
      b: blueYellow,
      count: 1,
      detailTotal: detailProtectionMap?.[sampleIndex] ?? 0
    });
  }

  const weightExponent = clamp(
    0.56 + imageProfile.flatArtworkScore * 0.12,
    0.54,
    0.7
  );

  return Array.from(bins.values()).map((bin) => ({
    l: bin.l / bin.count,
    a: bin.a / bin.count,
    b: bin.b / bin.count,
    detailScore: bin.detailTotal / bin.count,
    weight:
      Math.max(1, bin.count ** weightExponent) *
      (1 + (bin.detailTotal / bin.count) * 2.2)
  }));
};

const scoreArtworkPriorityItem = (item: QuantizationItem, imageProfile: ImageProfile) => {
  const chroma = labChroma(item.a, item.b);
  const rarityScore = clamp01(1.9 / Math.sqrt(item.weight + 0.3));
  const accentScore = clamp01((chroma - 10) / 30);

  return (
    item.detailScore * 0.62 +
    accentScore * (0.22 + imageProfile.flatArtworkScore * 0.12) +
    rarityScore * 0.18
  );
};

const buildArtworkHueFamilyStats = (
  items: QuantizationItem[],
  imageProfile: ImageProfile
) => {
  const families = new Map<string, ArtworkHueFamilyStats>();

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    const chroma = labChroma(item.a, item.b);
    const key = getArtworkHueFamilyKey(item.l, item.a, item.b);
    const family = families.get(key);

    if (family) {
      family.itemIndices.push(itemIndex);
      family.totalWeight += item.weight;
      family.detailWeightedTotal += item.detailScore * item.weight;
      family.priorityWeightedTotal +=
        scoreArtworkPriorityItem(item, imageProfile) * item.weight;
      family.minLightness = Math.min(family.minLightness, item.l);
      family.maxLightness = Math.max(family.maxLightness, item.l);
      family.minChroma = Math.min(family.minChroma, chroma);
      family.maxChroma = Math.max(family.maxChroma, chroma);
      family.meanChroma += chroma * item.weight;
      continue;
    }

    families.set(key, {
      key,
      itemIndices: [itemIndex],
      totalWeight: item.weight,
      detailWeightedTotal: item.detailScore * item.weight,
      priorityWeightedTotal: scoreArtworkPriorityItem(item, imageProfile) * item.weight,
      minLightness: item.l,
      maxLightness: item.l,
      minChroma: chroma,
      maxChroma: chroma,
      meanChroma: chroma * item.weight
    });
  }

  for (const family of families.values()) {
    family.meanChroma /= family.totalWeight;
  }

  return families;
};

const artworkHueVariationScore = (family: ArtworkHueFamilyStats) =>
  clamp01((family.maxLightness - family.minLightness - 4) / 16) * 0.48 +
  clamp01((family.maxChroma - family.minChroma - 3) / 14) * 0.32 +
  clamp01((family.itemIndices.length - 1) / 4) * 0.2;

const chooseArtworkSplitFamily = (
  items: QuantizationItem[],
  imageProfile: ImageProfile
) => {
  const families = Array.from(
    buildArtworkHueFamilyStats(items, imageProfile).values()
  );
  const totalWeight = families.reduce(
    (sum, family) => sum + family.totalWeight,
    0
  );
  let bestFamilyKey: string | null = null;
  let bestScore = -1;

  for (const family of families) {
    if (family.key.startsWith('neutral-') || totalWeight <= 0) {
      continue;
    }

    const weightRatio = family.totalWeight / totalWeight;
    const variation = artworkHueVariationScore(family);
    const meanPriority = family.priorityWeightedTotal / family.totalWeight;
    const meanDetail = family.detailWeightedTotal / family.totalWeight;
    const minorityBoost = clamp01((0.2 - weightRatio) / 0.12);
    const presenceScore = clamp01((weightRatio - 0.045) / 0.14);
    const chromaScore = clamp01((family.meanChroma - 12) / 24);
    const splitScore =
      variation * 0.34 +
      minorityBoost * 0.24 +
      meanPriority * 0.18 +
      presenceScore * 0.14 +
      meanDetail * 0.06 +
      chromaScore * 0.04;

    if (
      variation < 0.24 ||
      weightRatio < 0.045 ||
      family.itemIndices.length < 2 ||
      splitScore <= bestScore
    ) {
      continue;
    }

    bestFamilyKey = family.key;
    bestScore = splitScore;
  }

  return bestFamilyKey;
};

const chooseArtworkFamilyRepresentative = (
  items: QuantizationItem[],
  familyKey: string,
  selectedIndices: number[],
  imageProfile: ImageProfile
) => {
  let bestIndex = -1;
  let bestScore = -1;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    if (selectedIndices.includes(itemIndex)) {
      continue;
    }

    const item = items[itemIndex];

    if (getArtworkHueFamilyKey(item.l, item.a, item.b) !== familyKey) {
      continue;
    }

    const sameFamilySelections = selectedIndices.filter(
      (selectedIndex) =>
        getArtworkHueFamilyKey(
          items[selectedIndex].l,
          items[selectedIndex].a,
          items[selectedIndex].b
        ) === familyKey
    );
    const minDistance =
      sameFamilySelections.length === 0
        ? 14 ** 2
        : sameFamilySelections.reduce((nearest, selectedIndex) => {
            const selected = items[selectedIndex];
            const distance = labDistance(
              { l: item.l, a: item.a, b: item.b },
              { l: selected.l, a: selected.a, b: selected.b }
            );

            return Math.min(nearest, distance);
          }, Number.POSITIVE_INFINITY);
    const separationScore = clamp01((Math.sqrt(minDistance) - 4.5) / 12);
    const representativeScore =
      scoreArtworkPriorityItem(item, imageProfile) * 0.62 +
      separationScore * 0.3 +
      clamp01((labChroma(item.a, item.b) - 12) / 28) * 0.08;

    if (representativeScore > bestScore) {
      bestScore = representativeScore;
      bestIndex = itemIndex;
    }
  }

  return bestIndex;
};

const chooseArtworkLineSeedItemIndex = (
  items: QuantizationItem[],
  dominantItemIndex: number,
  imageProfile: ImageProfile
) => {
  const dominantItem = items[dominantItemIndex];
  let bestIndex = -1;
  let bestScore = 0;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    if (itemIndex === dominantItemIndex) {
      continue;
    }

    const item = items[itemIndex];
    const lightnessGap = Math.abs(item.l - dominantItem.l);
    const rarityScore = clamp01(1.8 / Math.sqrt(item.weight + 0.35));
    const neutralityScore = 1 - clamp01((labChroma(item.a, item.b) - 14) / 26);
    const separationScore = clamp01((lightnessGap - 12) / 26);
    const lineSeedScore =
      item.detailScore * 0.52 +
      separationScore * 0.26 +
      rarityScore * 0.14 +
      neutralityScore * (0.04 + imageProfile.flatArtworkScore * 0.04);

    if (
      item.detailScore < 0.32 ||
      lightnessGap < 12 ||
      lineSeedScore <= bestScore
    ) {
      continue;
    }

    bestScore = lineSeedScore;
    bestIndex = itemIndex;
  }

  return bestIndex;
};

const chooseArtworkSeedItemIndices = (
  items: QuantizationItem[],
  paletteSize: number,
  imageProfile: ImageProfile,
  dominantItemIndex?: number
) => {
  const reserveCount = Math.min(Math.max(2, Math.round(paletteSize * 0.4)), 4);
  const ranked = items
    .map((item, index) => ({
      index,
      score: scoreArtworkPriorityItem(item, imageProfile)
    }))
    .sort((left, right) => right.score - left.score);
  const chosen: number[] = [];
  const lineSeedIndex =
    dominantItemIndex === undefined
      ? -1
      : chooseArtworkLineSeedItemIndex(items, dominantItemIndex, imageProfile);
  const splitFamilyKey =
    reserveCount >= 3 ? chooseArtworkSplitFamily(items, imageProfile) : null;

  if (lineSeedIndex !== -1) {
    chosen.push(lineSeedIndex);
  }

  if (splitFamilyKey) {
    const representativeIndex = chooseArtworkFamilyRepresentative(
      items,
      splitFamilyKey,
      chosen,
      imageProfile
    );

    if (representativeIndex !== -1) {
      chosen.push(representativeIndex);
    }
  }

  for (const candidate of ranked) {
    if (
      splitFamilyKey &&
      chosen.length >= reserveCount - 1
    ) {
      break;
    }

    const item = items[candidate.index];
    const isDistinct = chosen.every((selectedIndex) => {
      const selected = items[selectedIndex];
      const distance = labDistance(
        { l: item.l, a: item.a, b: item.b },
        { l: selected.l, a: selected.a, b: selected.b }
      );

      return distance > 110 || item.detailScore > 0.42;
    });

    if (!isDistinct) {
      continue;
    }

    chosen.push(candidate.index);

    if (chosen.length >= reserveCount) {
      break;
    }
  }

  if (splitFamilyKey && chosen.length < reserveCount) {
    const splitIndex = chooseArtworkFamilyRepresentative(
      items,
      splitFamilyKey,
      chosen,
      imageProfile
    );

    if (splitIndex !== -1) {
      chosen.push(splitIndex);
    }
  }

  if (chosen.length < reserveCount) {
    for (const candidate of ranked) {
      if (chosen.includes(candidate.index)) {
        continue;
      }

      const item = items[candidate.index];
      const isDistinct = chosen.every((selectedIndex) => {
        const selected = items[selectedIndex];
        const distance = labDistance(
          { l: item.l, a: item.a, b: item.b },
          { l: selected.l, a: selected.a, b: selected.b }
        );

        return distance > 110 || item.detailScore > 0.42;
      });

      if (!isDistinct) {
        continue;
      }

      chosen.push(candidate.index);

      if (chosen.length >= reserveCount) {
        break;
      }
    }
  }

  return chosen;
};

const computeDetailProtectionMap = (
  imageData: ImageData,
  imageProfile: ImageProfile
) => {
  const scores = new Float32Array(imageData.width * imageData.height);

  if (
    imageProfile.flatArtworkScore < 0.16 &&
    imageProfile.monochromeScore < 0.22
  ) {
    return scores;
  }

  const luminance = computeLuminancePixels(imageData);
  const protectionScale = clamp(
    0.25 +
      imageProfile.flatArtworkScore * 0.55 +
      imageProfile.monochromeScore * 0.3,
    0.25,
    1
  );

  for (let pixelIndex = 0; pixelIndex < scores.length; pixelIndex += 1) {
    const x = pixelIndex % imageData.width;
    const y = Math.floor(pixelIndex / imageData.width);
    const sourceIndex = pixelIndex * 4;
    const red = imageData.data[sourceIndex];
    const green = imageData.data[sourceIndex + 1];
    const blue = imageData.data[sourceIndex + 2];
    const currentLuminance = luminance[pixelIndex];
    let maxContrast = 0;
    let neighborLuminanceSum = 0;
    let neighborCount = 0;
    let highContrastNeighbors = 0;
    let lowContrastNeighbors = 0;

    for (const offset of neighborOffsets) {
      const nx = x + offset.dx;
      const ny = y + offset.dy;

      if (nx < 0 || nx >= imageData.width || ny < 0 || ny >= imageData.height) {
        continue;
      }

      const neighborIndex = ny * imageData.width + nx;
      const neighborSourceIndex = neighborIndex * 4;
      const deltaLuminance = Math.abs(currentLuminance - luminance[neighborIndex]);
      const deltaColor =
        Math.abs(red - imageData.data[neighborSourceIndex]) +
        Math.abs(green - imageData.data[neighborSourceIndex + 1]) +
        Math.abs(blue - imageData.data[neighborSourceIndex + 2]);
      const contrast = deltaLuminance + deltaColor * 0.14;

      neighborLuminanceSum += luminance[neighborIndex];
      neighborCount += 1;
      maxContrast = Math.max(maxContrast, contrast);

      if (contrast >= 44) {
        highContrastNeighbors += 1;
      } else if (contrast <= 16) {
        lowContrastNeighbors += 1;
      }
    }

    if (neighborCount === 0) {
      continue;
    }

    const meanNeighborLuminance = neighborLuminanceSum / neighborCount;
    const localEdgeScore = clamp01((maxContrast - 22) / 82);
    const localExtremeness = clamp01(
      (Math.abs(currentLuminance - meanNeighborLuminance) - 18) / 78
    );
    const thinLineBoost =
      highContrastNeighbors >= 2 && lowContrastNeighbors <= 2 ? 0.28 : 0;

    scores[pixelIndex] = clamp01(
      (localEdgeScore * (0.52 + localExtremeness * 0.3 + thinLineBoost)) *
        protectionScale
    );
  }

  return scores;
};

const dilateMask = (
  mask: Uint8Array,
  width: number,
  height: number,
  iterations = 1
) => {
  let current = new Uint8Array(mask);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Uint8Array(current);

    for (let pixelIndex = 0; pixelIndex < current.length; pixelIndex += 1) {
      if (current[pixelIndex] === 0) {
        continue;
      }

      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);

      for (const offset of smoothingOffsets) {
        const nx = x + offset.dx;
        const ny = y + offset.dy;

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }

        next[ny * width + nx] = 1;
      }
    }

    current = next;
  }

  return current;
};

const averageLabFromPixelList = (labs: Float32Array, pixelIndices: number[]) => {
  let totalL = 0;
  let totalA = 0;
  let totalB = 0;

  for (const pixelIndex of pixelIndices) {
    const offset = pixelIndex * 3;
    totalL += labs[offset];
    totalA += labs[offset + 1];
    totalB += labs[offset + 2];
  }

  return {
    l: totalL / pixelIndices.length,
    a: totalA / pixelIndices.length,
    b: totalB / pixelIndices.length
  };
};

const buildLineworkStrokeMask = (
  imageData: ImageData,
  detailProtectionMap: Float32Array,
  dilationIterations = 1
) => {
  const luminance = computeLuminancePixels(imageData);
  const strokeMask = new Uint8Array(imageData.width * imageData.height);

  for (let pixelIndex = 0; pixelIndex < strokeMask.length; pixelIndex += 1) {
    const detailScore = detailProtectionMap[pixelIndex];
    const x = pixelIndex % imageData.width;
    const y = Math.floor(pixelIndex / imageData.width);
    const currentLuminance = luminance[pixelIndex];
    let neighborLuminanceTotal = 0;
    let neighborCount = 0;
    let strongContrastNeighbors = 0;
    let similarNeighbors = 0;
    let brighterNeighbors = 0;
    let darkerNeighbors = 0;
    let colorContrastNeighbors = 0;

    if (detailScore < 0.28) {
      continue;
    }

    for (const offset of smoothingOffsets) {
      const nx = x + offset.dx;
      const ny = y + offset.dy;

      if (nx < 0 || nx >= imageData.width || ny < 0 || ny >= imageData.height) {
        continue;
      }

      const neighborIndex = ny * imageData.width + nx;
      const delta = currentLuminance - luminance[neighborIndex];
      const absDelta = Math.abs(delta);
      const sourceIndex = pixelIndex * 4;
      const neighborSourceIndex = neighborIndex * 4;
      const colorDelta =
        Math.abs(imageData.data[sourceIndex] - imageData.data[neighborSourceIndex]) +
        Math.abs(
          imageData.data[sourceIndex + 1] - imageData.data[neighborSourceIndex + 1]
        ) +
        Math.abs(
          imageData.data[sourceIndex + 2] - imageData.data[neighborSourceIndex + 2]
        );

      neighborLuminanceTotal += luminance[neighborIndex];
      neighborCount += 1;

      if (absDelta >= 22) {
        strongContrastNeighbors += 1;
      } else if (absDelta <= 9) {
        similarNeighbors += 1;
      }

      if (colorDelta >= 52) {
        colorContrastNeighbors += 1;
      }

      if (delta >= 16) {
        brighterNeighbors += 1;
      } else if (delta <= -16) {
        darkerNeighbors += 1;
      }
    }

    if (neighborCount === 0) {
      continue;
    }

    const meanNeighborLuminance = neighborLuminanceTotal / neighborCount;
    const localLuminanceDelta = currentLuminance - meanNeighborLuminance;
    const likelyBrightStroke =
      localLuminanceDelta >= 12 &&
      brighterNeighbors >= 2 &&
      (strongContrastNeighbors >= 2 || colorContrastNeighbors >= 2) &&
      (similarNeighbors >= 1 || detailScore >= 0.5);
    const likelyDarkStroke =
      localLuminanceDelta <= -14 &&
      darkerNeighbors >= 2 &&
      (strongContrastNeighbors >= 2 || colorContrastNeighbors >= 2) &&
      (similarNeighbors >= 1 || detailScore >= 0.5);
    const likelyEdgeStroke =
      Math.abs(localLuminanceDelta) >= 10 &&
      strongContrastNeighbors + colorContrastNeighbors >= 3 &&
      similarNeighbors <= 4 &&
      ((localLuminanceDelta >= 0 && brighterNeighbors >= 1) ||
        (localLuminanceDelta < 0 && darkerNeighbors >= 1));

    if (
      (detailScore >= 0.36 &&
        (likelyBrightStroke || likelyDarkStroke) &&
        strongContrastNeighbors + colorContrastNeighbors <= 9) ||
      (detailScore >= 0.22 && likelyEdgeStroke) ||
      (detailScore >= 0.58 &&
        Math.abs(localLuminanceDelta) >= 14 &&
        strongContrastNeighbors + colorContrastNeighbors >= 2)
    ) {
      strokeMask[pixelIndex] = 1;
    }
  }

  return dilationIterations > 0
    ? dilateMask(strokeMask, imageData.width, imageData.height, dilationIterations)
    : strokeMask;
};

const strengthenArtworkLineProtection = (
  imageData: ImageData,
  imageProfile: ImageProfile,
  detailProtectionMap: Float32Array
) => {
  if (imageProfile.renderingMode !== 'artwork') {
    return detailProtectionMap;
  }

  const coreStrokeMask = buildLineworkStrokeMask(
    imageData,
    detailProtectionMap,
    0
  );
  let strokePixelCount = 0;

  for (const pixel of coreStrokeMask) {
    if (pixel === 1) {
      strokePixelCount += 1;
    }
  }

  if (strokePixelCount < Math.max(10, Math.round(coreStrokeMask.length * 0.006))) {
    return detailProtectionMap;
  }

  const strengthened = new Float32Array(detailProtectionMap);

  for (let pixelIndex = 0; pixelIndex < strengthened.length; pixelIndex += 1) {
    if (coreStrokeMask[pixelIndex] === 1) {
      strengthened[pixelIndex] = Math.max(strengthened[pixelIndex], 0.94);
      continue;
    }

    if (strengthened[pixelIndex] < 0.28) {
      continue;
    }

    const x = pixelIndex % imageData.width;
    const y = Math.floor(pixelIndex / imageData.width);
    let adjacentStrokeCount = 0;

    for (const offset of neighborOffsets) {
      const nx = x + offset.dx;
      const ny = y + offset.dy;

      if (nx < 0 || nx >= imageData.width || ny < 0 || ny >= imageData.height) {
        continue;
      }

      if (coreStrokeMask[ny * imageData.width + nx] === 1) {
        adjacentStrokeCount += 1;
      }
    }

    if (adjacentStrokeCount >= 2) {
      strengthened[pixelIndex] = Math.max(strengthened[pixelIndex], 0.68);
    }
  }

  return strengthened;
};

const normalizeArtworkBackground = (
  imageData: ImageData,
  imageProfile: ImageProfile,
  detailProtectionMap: Float32Array
) => {
  if (
    imageProfile.renderingMode !== 'artwork' ||
    imageProfile.flatArtworkScore < 0.28
  ) {
    return imageData;
  }

  const width = imageData.width;
  const height = imageData.height;
  const totalPixels = width * height;
  const labs = computeLabPixels(imageData);
  const borderThickness = clamp(Math.round(Math.min(width, height) / 18), 1, 4);
  const borderIndices = collectBorderPixelIndices(width, height, borderThickness);
  const borderBins = new Map<
    string,
    { count: number; l: number; a: number; b: number; samples: number }
  >();
  let eligibleBorderPixels = 0;

  for (const pixelIndex of borderIndices) {
    if (detailProtectionMap[pixelIndex] > 0.34) {
      continue;
    }

    const offset = pixelIndex * 3;
    const key = [
      Math.round(labs[offset] / 6),
      Math.round((labs[offset + 1] + 110) / 12),
      Math.round((labs[offset + 2] + 110) / 12)
    ].join(':');
    const existing = borderBins.get(key);

    if (existing) {
      existing.count += 1;
      existing.l += labs[offset];
      existing.a += labs[offset + 1];
      existing.b += labs[offset + 2];
      existing.samples += 1;
    } else {
      borderBins.set(key, {
        count: 1,
        l: labs[offset],
        a: labs[offset + 1],
        b: labs[offset + 2],
        samples: 1
      });
    }

    eligibleBorderPixels += 1;
  }

  if (eligibleBorderPixels === 0 || borderBins.size === 0) {
    return imageData;
  }

  const dominantBin = Array.from(borderBins.entries()).sort(
    (left, right) => right[1].count - left[1].count
  )[0];

  if (!dominantBin || dominantBin[1].count / eligibleBorderPixels < 0.44) {
    return imageData;
  }

  const isLineworkArtwork =
    imageProfile.monochromeScore > 0.52 &&
    imageProfile.flatArtworkScore > 0.28;
  const dominantLab = {
    l: dominantBin[1].l / dominantBin[1].samples,
    a: dominantBin[1].a / dominantBin[1].samples,
    b: dominantBin[1].b / dominantBin[1].samples
  };
  const distanceThreshold =
    imageProfile.monochromeScore > 0.6
      ? isLineworkArtwork
        ? 38 ** 2
        : 30 ** 2
      : 26 ** 2;
  const strokeMask = isLineworkArtwork
    ? buildLineworkStrokeMask(imageData, detailProtectionMap)
    : new Uint8Array(totalPixels);
  const visited = new Uint8Array(totalPixels);
  const queue: number[] = [];
  let head = 0;

  for (const pixelIndex of borderIndices) {
    if (visited[pixelIndex] || strokeMask[pixelIndex] === 1) {
      continue;
    }

    const offset = pixelIndex * 3;
    const distance = labDistance(dominantLab, {
      l: labs[offset],
      a: labs[offset + 1],
      b: labs[offset + 2]
    });

    if (
      detailProtectionMap[pixelIndex] <= 0.34 &&
      distance <= distanceThreshold
    ) {
      visited[pixelIndex] = 1;
      queue.push(pixelIndex);
    }
  }

  while (head < queue.length) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);

    for (const offset of neighborOffsets) {
      const nx = x + offset.dx;
      const ny = y + offset.dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        continue;
      }

      const neighborIndex = ny * width + nx;

      if (
        visited[neighborIndex] ||
        strokeMask[neighborIndex] === 1 ||
        detailProtectionMap[neighborIndex] >
          (isLineworkArtwork ? 0.56 : 0.38)
      ) {
        continue;
      }

      const neighborOffset = neighborIndex * 3;
      const distance = labDistance(dominantLab, {
        l: labs[neighborOffset],
        a: labs[neighborOffset + 1],
        b: labs[neighborOffset + 2]
      });

      if (distance > distanceThreshold) {
        continue;
      }

      visited[neighborIndex] = 1;
      queue.push(neighborIndex);
    }
  }

  const backgroundPixels = queue.length;
  const backgroundCoverage = backgroundPixels / totalPixels;
  let borderHitCount = 0;

  for (const pixelIndex of borderIndices) {
    if (visited[pixelIndex] === 1) {
      borderHitCount += 1;
    }
  }

  const borderCoverage = borderHitCount / borderIndices.length;

  if (backgroundCoverage < 0.18 || borderCoverage < 0.52) {
    return imageData;
  }

  const normalized = cloneImageData(imageData);
  const normalizedLab = averageLabFromPixelList(labs, queue);
  const normalizedRgb = labToRgb(normalizedLab.l, normalizedLab.a, normalizedLab.b);

  for (const pixelIndex of queue) {
    const sourceIndex = pixelIndex * 4;
    normalized.data[sourceIndex] = normalizedRgb[0];
    normalized.data[sourceIndex + 1] = normalizedRgb[1];
    normalized.data[sourceIndex + 2] = normalizedRgb[2];
  }

  if (!isLineworkArtwork) {
    return normalized;
  }

  const strokePixels: number[] = [];
  const fillPixels: number[] = [];

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    if (visited[pixelIndex] === 1) {
      continue;
    }

    if (strokeMask[pixelIndex] === 1) {
      strokePixels.push(pixelIndex);
    } else {
      fillPixels.push(pixelIndex);
    }
  }

  if (strokePixels.length === 0 || fillPixels.length === 0) {
    return normalized;
  }

  const strokeLab = averageLabFromPixelList(labs, strokePixels);
  const fillLab = averageLabFromPixelList(labs, fillPixels);
  const separationNeedsLift =
    labDistance(normalizedLab, fillLab) < 18 ** 2;
  const fillTargetLab = {
    l: clamp(
      fillLab.l + (separationNeedsLift ? (normalizedLab.l < 55 ? 9 : -9) : 0),
      0,
      100
    ),
    a: fillLab.a,
    b: fillLab.b
  };
  const strokeTargetLab =
    normalizedLab.l < 55
      ? {
          l: clamp(Math.max(strokeLab.l, normalizedLab.l + 34, 84), 0, 100),
          a: strokeLab.a,
          b: strokeLab.b
        }
      : {
          l: clamp(Math.min(strokeLab.l, normalizedLab.l - 28, 18), 0, 100),
          a: strokeLab.a,
          b: strokeLab.b
        };
  const strokeRgb = labToRgb(
    strokeTargetLab.l,
    strokeTargetLab.a,
    strokeTargetLab.b
  );

  for (const pixelIndex of strokePixels) {
    const sourceIndex = pixelIndex * 4;
    normalized.data[sourceIndex] = strokeRgb[0];
    normalized.data[sourceIndex + 1] = strokeRgb[1];
    normalized.data[sourceIndex + 2] = strokeRgb[2];
  }

  for (const pixelIndex of fillPixels) {
    const offset = pixelIndex * 3;
    const blend = clamp(0.72 - detailProtectionMap[pixelIndex] * 0.35, 0.42, 0.78);
    const blendedLab = {
      l: labs[offset] * (1 - blend) + fillTargetLab.l * blend,
      a: labs[offset + 1] * (1 - blend) + fillTargetLab.a * blend,
      b: labs[offset + 2] * (1 - blend) + fillTargetLab.b * blend
    };
    const rgb = labToRgb(blendedLab.l, blendedLab.a, blendedLab.b);
    const sourceIndex = pixelIndex * 4;
    normalized.data[sourceIndex] = rgb[0];
    normalized.data[sourceIndex + 1] = rgb[1];
    normalized.data[sourceIndex + 2] = rgb[2];
  }

  return normalized;
};

const chooseSampleIndices = (pixelCount: number, maxSamples: number) => {
  if (pixelCount <= maxSamples) {
    return Array.from({ length: pixelCount }, (_, index) => index);
  }

  const stride = pixelCount / maxSamples;
  return Array.from({ length: maxSamples }, (_, index) =>
    Math.min(pixelCount - 1, Math.floor(index * stride))
  );
};

const farthestSampleIndex = (
  items: QuantizationItem[],
  centroids: Float32Array,
  centroidCount: number,
  imageProfile?: ImageProfile,
  excludedIndices?: Set<number>
) => {
  let bestIndex = 0;
  let bestDistance = -1;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    if (excludedIndices?.has(itemIndex)) {
      continue;
    }

    const item = items[itemIndex];
    const lab = {
      l: item.l,
      a: item.a,
      b: item.b
    };
    let nearest = Number.POSITIVE_INFINITY;

    for (let centroidIndex = 0; centroidIndex < centroidCount; centroidIndex += 1) {
      const centroidOffset = centroidIndex * 3;
      const centroid = {
        l: centroids[centroidOffset],
        a: centroids[centroidOffset + 1],
        b: centroids[centroidOffset + 2]
      };
      nearest = Math.min(nearest, labDistance(lab, centroid));
    }

    const chroma = Math.hypot(item.a, item.b);
    const rarityBoost = imageProfile
      ? 1 +
        imageProfile.flatArtworkScore *
          clamp01(1.8 / Math.sqrt(item.weight + 0.35)) *
          0.14
      : 1;
    const accentBoost = imageProfile
      ? 1 +
        imageProfile.flatArtworkScore * clamp01((chroma - 12) / 34) * 0.22
      : 1;
    const score = nearest * rarityBoost * accentBoost;

    if (score > bestDistance) {
      bestDistance = score;
      bestIndex = itemIndex;
    }
  }

  return bestIndex;
};

export const quantizeImageData = (
  imageData: ImageData,
  options: PatternOptions,
  imageProfile?: ImageProfile,
  detailProtectionMap?: Float32Array
): {
  palette: PaletteEntry[];
  pixels: Uint8Array;
} => {
  const pixelCount = imageData.width * imageData.height;
  const labs = computeLabPixels(imageData);
  const sampleIndices = chooseSampleIndices(
    pixelCount,
    Math.max(9000, options.paletteSize * 450)
  );
  const items = buildQuantizationItems(
    labs,
    sampleIndices,
    imageProfile,
    detailProtectionMap
  );
  const centroidCount = Math.max(1, Math.min(options.paletteSize, items.length));
  const centroids = new Float32Array(centroidCount * 3);
  const useDirectArtworkBins =
    imageProfile?.renderingMode === 'artwork' &&
    imageProfile.flatArtworkScore > 0.26 &&
    items.length <= centroidCount;

  if (items.length === 0) {
    throw new Error('The uploaded image does not contain any pixels.');
  }

  if (useDirectArtworkBins) {
    for (let centroidIndex = 0; centroidIndex < centroidCount; centroidIndex += 1) {
      const centroidOffset = centroidIndex * 3;
      centroids[centroidOffset] = items[centroidIndex].l;
      centroids[centroidOffset + 1] = items[centroidIndex].a;
      centroids[centroidOffset + 2] = items[centroidIndex].b;
    }
  } else {
    const dominantItemIndex = items.reduce(
      (bestIndex, item, index) =>
        item.weight > items[bestIndex].weight ? index : bestIndex,
      0
    );
    const seedIndices = [dominantItemIndex];

    if (imageProfile?.renderingMode === 'artwork') {
      for (const itemIndex of chooseArtworkSeedItemIndices(
        items,
        centroidCount,
        imageProfile,
        dominantItemIndex
      )) {
        if (!seedIndices.includes(itemIndex)) {
          seedIndices.push(itemIndex);
        }
      }
    }

    const usedSeedIndices = new Set<number>();

    for (let centroidIndex = 0; centroidIndex < Math.min(centroidCount, seedIndices.length); centroidIndex += 1) {
      const itemIndex = seedIndices[centroidIndex];
      const centroidOffset = centroidIndex * 3;
      centroids[centroidOffset] = items[itemIndex].l;
      centroids[centroidOffset + 1] = items[itemIndex].a;
      centroids[centroidOffset + 2] = items[itemIndex].b;
      usedSeedIndices.add(itemIndex);
    }

    for (let centroidIndex = usedSeedIndices.size; centroidIndex < centroidCount; centroidIndex += 1) {
      const itemIndex = farthestSampleIndex(
        items,
        centroids,
        centroidIndex,
        imageProfile,
        usedSeedIndices
      );
      const centroidOffset = centroidIndex * 3;
      centroids[centroidOffset] = items[itemIndex].l;
      centroids[centroidOffset + 1] = items[itemIndex].a;
      centroids[centroidOffset + 2] = items[itemIndex].b;
      usedSeedIndices.add(itemIndex);
    }

    for (let iteration = 0; iteration < options.maxKMeansIterations; iteration += 1) {
      const sums = new Float32Array(centroidCount * 3);
      const counts = new Float32Array(centroidCount);

      for (const item of items) {
        let nearestCentroid = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (let centroidIndex = 0; centroidIndex < centroidCount; centroidIndex += 1) {
          const centroidOffset = centroidIndex * 3;
          const distance =
            (item.l - centroids[centroidOffset]) ** 2 +
            (item.a - centroids[centroidOffset + 1]) ** 2 +
            (item.b - centroids[centroidOffset + 2]) ** 2;

          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestCentroid = centroidIndex;
          }
        }

        const sumOffset = nearestCentroid * 3;
        sums[sumOffset] += item.l * item.weight;
        sums[sumOffset + 1] += item.a * item.weight;
        sums[sumOffset + 2] += item.b * item.weight;
        counts[nearestCentroid] += item.weight;
      }

      for (let centroidIndex = 0; centroidIndex < centroidCount; centroidIndex += 1) {
        const centroidOffset = centroidIndex * 3;

        if (counts[centroidIndex] === 0) {
          const replacementItem = items[(centroidIndex * 487) % items.length];
          centroids[centroidOffset] = replacementItem.l;
          centroids[centroidOffset + 1] = replacementItem.a;
          centroids[centroidOffset + 2] = replacementItem.b;
          continue;
        }

        centroids[centroidOffset] = sums[centroidOffset] / counts[centroidIndex];
        centroids[centroidOffset + 1] = sums[centroidOffset + 1] / counts[centroidIndex];
        centroids[centroidOffset + 2] = sums[centroidOffset + 2] / counts[centroidIndex];
      }
    }
  }

  const assignments = new Uint8Array(pixelCount);
  const usage = new Uint32Array(centroidCount);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 3;
    let nearestCentroid = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let centroidIndex = 0; centroidIndex < centroidCount; centroidIndex += 1) {
      const centroidOffset = centroidIndex * 3;
      const distance =
        (labs[offset] - centroids[centroidOffset]) ** 2 +
        (labs[offset + 1] - centroids[centroidOffset + 1]) ** 2 +
        (labs[offset + 2] - centroids[centroidOffset + 2]) ** 2;

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestCentroid = centroidIndex;
      }
    }

    assignments[pixelIndex] = nearestCentroid;
    usage[nearestCentroid] += 1;
  }

  const sortablePalette = Array.from({ length: centroidCount }, (_, index) => {
    const offset = index * 3;
    const lab = {
      l: centroids[offset],
      a: centroids[offset + 1],
      b: centroids[offset + 2]
    };
    const rgb = labToRgb(lab.l, lab.a, lab.b);

    return {
      originalIndex: index,
      rgb,
      lightness: lab.l,
      hue: labHue(lab),
      usage: usage[index] / pixelCount
    };
  }).sort((left, right) => {
    if (Math.abs(left.lightness - right.lightness) > 1) {
      return left.lightness - right.lightness;
    }

    return left.hue - right.hue;
  });

  const remap = new Uint8Array(centroidCount);
  const palette: PaletteEntry[] = sortablePalette.map((entry, index) => {
    remap[entry.originalIndex] = index;

    return {
      index,
      number: index + 1,
      rgb: entry.rgb,
      hex: rgbToHex(entry.rgb[0], entry.rgb[1], entry.rgb[2]),
      label: `Color ${index + 1}`,
      lightness: entry.lightness,
      usage: entry.usage
    };
  });

  for (let pixelIndex = 0; pixelIndex < assignments.length; pixelIndex += 1) {
    assignments[pixelIndex] = remap[assignments[pixelIndex]];
  }

  return {
    palette,
    pixels: assignments
  };
};

const reserveLineworkStrokePaletteSlot = (
  imageData: ImageData,
  quantized: {
    palette: PaletteEntry[];
    pixels: Uint8Array;
  },
  imageProfile: ImageProfile,
  detailProtectionMap: Float32Array
): LineworkQuantizedResult => {
  const isLineworkArtwork = imageProfile.renderingMode === 'artwork';

  if (!isLineworkArtwork || quantized.palette.length < 2) {
    return quantized;
  }

  const strokeMask = buildLineworkStrokeMask(imageData, detailProtectionMap, 0);
  const strokePixels: number[] = [];
  const nonStrokePixels: number[] = [];

  for (let pixelIndex = 0; pixelIndex < strokeMask.length; pixelIndex += 1) {
    if (strokeMask[pixelIndex] === 1) {
      strokePixels.push(pixelIndex);
    } else {
      nonStrokePixels.push(pixelIndex);
    }
  }

  if (
    strokePixels.length < Math.max(10, Math.round(strokeMask.length * 0.006)) ||
    nonStrokePixels.length === 0
  ) {
    return quantized;
  }

  const labs = computeLabPixels(imageData);
  const strokeLab = averageLabFromPixelList(labs, strokePixels);
  const surroundingLab = averageLabFromPixelList(labs, nonStrokePixels);
  const adjustedStrokeLab =
    strokeLab.l >= surroundingLab.l
      ? {
          ...strokeLab,
          l: clamp(
            Math.max(strokeLab.l + 10, surroundingLab.l + 20, 86),
            0,
            100
          )
        }
      : {
          ...strokeLab,
          l: clamp(
            Math.min(strokeLab.l - 10, surroundingLab.l - 20, 18),
            0,
            100
          )
        };
  const strokeRgb = labToRgb(
    adjustedStrokeLab.l,
    adjustedStrokeLab.a,
    adjustedStrokeLab.b
  );
  const paletteLabs = quantized.palette.map((entry) =>
    rgbToLab(entry.rgb[0], entry.rgb[1], entry.rgb[2])
  );
  const strokePaletteIndex = quantized.palette.reduce((bestIndex, entry, index) => {
    const bestEntry = quantized.palette[bestIndex];

    if (adjustedStrokeLab.l >= surroundingLab.l) {
      return entry.lightness > bestEntry.lightness ? index : bestIndex;
    }

    return entry.lightness < bestEntry.lightness ? index : bestIndex;
  }, 0);
  const reassignedPixels = new Uint8Array(quantized.pixels);

  for (let pixelIndex = 0; pixelIndex < reassignedPixels.length; pixelIndex += 1) {
    if (
      strokeMask[pixelIndex] === 1 ||
      reassignedPixels[pixelIndex] !== strokePaletteIndex
    ) {
      continue;
    }

    const offset = pixelIndex * 3;
    let nearestIndex = strokePaletteIndex;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let paletteIndex = 0; paletteIndex < paletteLabs.length; paletteIndex += 1) {
      if (paletteIndex === strokePaletteIndex) {
        continue;
      }

      const distance = labDistance(
        {
          l: labs[offset],
          a: labs[offset + 1],
          b: labs[offset + 2]
        },
        paletteLabs[paletteIndex]
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = paletteIndex;
      }
    }

    reassignedPixels[pixelIndex] = nearestIndex;
  }

  for (const pixelIndex of strokePixels) {
    reassignedPixels[pixelIndex] = strokePaletteIndex;
  }

  const updatedPalette = quantized.palette.map((entry, index) =>
    index === strokePaletteIndex
      ? {
          ...entry,
          rgb: strokeRgb,
          hex: rgbToHex(strokeRgb[0], strokeRgb[1], strokeRgb[2]),
          lightness: adjustedStrokeLab.l
        }
      : entry
  );

  return {
    palette: updatedPalette,
    pixels: reassignedPixels,
    strokeMask,
    strokePaletteIndex
  };
};

const reinforceStrokePixels = (
  pixels: Uint8Array,
  strokeMask?: Uint8Array,
  strokePaletteIndex?: number
) => {
  if (!strokeMask || strokePaletteIndex === undefined) {
    return pixels;
  }

  const reinforced = new Uint8Array(pixels);

  for (let pixelIndex = 0; pixelIndex < reinforced.length; pixelIndex += 1) {
    if (strokeMask[pixelIndex] === 1) {
      reinforced[pixelIndex] = strokePaletteIndex;
    }
  }

  return reinforced;
};

const buildPaletteIndexMask = (
  pixels: Uint8Array,
  paletteIndex?: number
) => {
  if (paletteIndex === undefined) {
    return undefined;
  }

  const mask = new Uint8Array(pixels.length);

  for (let pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += 1) {
    if (pixels[pixelIndex] === paletteIndex) {
      mask[pixelIndex] = 1;
    }
  }

  return mask;
};

const mergeMasks = (
  primaryMask?: Uint8Array,
  secondaryMask?: Uint8Array
) => {
  if (!primaryMask) {
    return secondaryMask;
  }

  if (!secondaryMask) {
    return primaryMask;
  }

  const merged = new Uint8Array(primaryMask.length);

  for (let pixelIndex = 0; pixelIndex < merged.length; pixelIndex += 1) {
    if (primaryMask[pixelIndex] === 1 || secondaryMask[pixelIndex] === 1) {
      merged[pixelIndex] = 1;
    }
  }

  return merged;
};

const countStrokeMaskPixels = (strokeMask: Uint8Array) => {
  let count = 0;

  for (const pixel of strokeMask) {
    if (pixel === 1) {
      count += 1;
    }
  }

  return count;
};

const chooseArtworkLinePaletteIndex = (
  palette: PaletteEntry[],
  imageProfile: ImageProfile
) => {
  if (imageProfile.renderingMode !== 'artwork' || palette.length < 4) {
    return undefined;
  }

  const byLightness = [...palette].sort((left, right) => left.lightness - right.lightness);
  const darkest = byLightness[0];
  const secondDarkest = byLightness[1];
  const secondLightest = byLightness[byLightness.length - 2];
  const lightest = byLightness[byLightness.length - 1];

  if (
    lightest.usage <= 0.12 &&
    lightest.lightness - secondLightest.lightness >= 4
  ) {
    return lightest.index;
  }

  if (
    darkest.usage <= 0.12 &&
    secondDarkest.lightness - darkest.lightness >= 4
  ) {
    return darkest.index;
  }

  return undefined;
};

const compactPaletteToUsedColors = (
  palette: PaletteEntry[],
  pixels: Uint8Array
) => {
  const usageCounts = new Uint32Array(palette.length);

  for (const paletteIndex of pixels) {
    usageCounts[paletteIndex] += 1;
  }

  const usedIndices = palette
    .map((_, index) => index)
    .filter((index) => usageCounts[index] > 0);
  const remap = new Uint8Array(palette.length);
  const totalPixels = pixels.length;
  const compactPalette = usedIndices.map((originalIndex, compactIndex) => {
    remap[originalIndex] = compactIndex;
    const entry = palette[originalIndex];

    return {
      ...entry,
      index: compactIndex,
      number: compactIndex + 1,
      label: `Color ${compactIndex + 1}`,
      usage: usageCounts[originalIndex] / totalPixels
    };
  });
  const compactPixels = new Uint8Array(pixels.length);

  for (let pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += 1) {
    compactPixels[pixelIndex] = remap[pixels[pixelIndex]];
  }

  return {
    palette: compactPalette,
    pixels: compactPixels
  };
};

const mergeSimilarPaletteEntries = (
  palette: PaletteEntry[],
  pixels: Uint8Array,
  distanceThreshold: number
) => {
  if (palette.length === 0) {
    return {
      palette,
      pixels
    };
  }

  const compacted = compactPaletteToUsedColors(palette, pixels);

  if (distanceThreshold <= 0 || compacted.palette.length <= 1) {
    return compacted;
  }

  const labs = compacted.palette.map((entry) =>
    rgbToLab(entry.rgb[0], entry.rgb[1], entry.rgb[2])
  );
  const remap = new Uint8Array(compacted.palette.length);

  for (let index = 0; index < remap.length; index += 1) {
    remap[index] = index;
  }

  for (let index = 1; index < compacted.palette.length; index += 1) {
    let nearestMatch = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let candidate = 0; candidate < index; candidate += 1) {
      const distance = labDistance(labs[index], labs[candidate]);

      if (distance <= distanceThreshold && distance < nearestDistance) {
        nearestDistance = distance;
        nearestMatch = remap[candidate];
      }
    }

    if (nearestMatch !== -1) {
      remap[index] = nearestMatch;
    }
  }

  const mergedPixels = new Uint8Array(compacted.pixels.length);

  for (let pixelIndex = 0; pixelIndex < compacted.pixels.length; pixelIndex += 1) {
    mergedPixels[pixelIndex] = remap[compacted.pixels[pixelIndex]];
  }

  return compactPaletteToUsedColors(compacted.palette, mergedPixels);
};

const labelComponents = (
  pixels: Uint8Array,
  width: number,
  height: number
) => {
  const visited = new Int32Array(pixels.length);
  visited.fill(-1);
  const components: Component[] = [];

  for (let startIndex = 0; startIndex < pixels.length; startIndex += 1) {
    if (visited[startIndex] !== -1) {
      continue;
    }

    const paletteIndex = pixels[startIndex];
    const queue = [startIndex];
    const componentIndex = components.length;
    visited[startIndex] = componentIndex;
    const componentPixels: number[] = [];
    let head = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const neighborCounts = new Map<number, number>();

    while (head < queue.length) {
      const pixelIndex = queue[head];
      head += 1;
      componentPixels.push(pixelIndex);

      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (const offset of neighborOffsets) {
        const nx = x + offset.dx;
        const ny = y + offset.dy;

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }

        const neighborIndex = ny * width + nx;

        if (pixels[neighborIndex] === paletteIndex) {
          if (visited[neighborIndex] === -1) {
            visited[neighborIndex] = componentIndex;
            queue.push(neighborIndex);
          }
          continue;
        }

        neighborCounts.set(
          pixels[neighborIndex],
          (neighborCounts.get(pixels[neighborIndex]) ?? 0) + 1
        );
      }
    }

    components.push({
      paletteIndex,
      pixelCount: componentPixels.length,
      pixels: componentPixels,
      minX,
      minY,
      maxX,
      maxY,
      neighborCounts
    });
  }

  return components;
};

export const mergeSmallRegions = (
  pixels: Uint8Array,
  width: number,
  height: number,
  minRegionPixels: number,
  sceneMap?: SceneMap,
  cleanupStrength = 1,
  detailProtectionMap?: Float32Array
) => {
  const merged = new Uint8Array(pixels);

  const getComponentSceneScore = (component: Component) => {
    if (!sceneMap || component.pixels.length === 0) {
      return 0;
    }

    const stride = Math.max(1, Math.floor(component.pixels.length / 24));
    let total = 0;
    let samples = 0;

    for (let index = 0; index < component.pixels.length; index += stride) {
      const pixelIndex = component.pixels[index];
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      total += sampleSceneScore(sceneMap, x + 0.5, y + 0.5);
      samples += 1;
    }

    return samples === 0 ? 0 : total / samples;
  };

  const getComponentDetailScore = (component: Component) => {
    if (!detailProtectionMap || component.pixels.length === 0) {
      return 0;
    }

    const stride = Math.max(1, Math.floor(component.pixels.length / 24));
    let total = 0;
    let samples = 0;

    for (let index = 0; index < component.pixels.length; index += stride) {
      total += detailProtectionMap[component.pixels[index]];
      samples += 1;
    }

    return samples === 0 ? 0 : total / samples;
  };

  const shouldMergeComponent = (component: Component) => {
    const regionWidth = component.maxX - component.minX + 1;
    const regionHeight = component.maxY - component.minY + 1;
    const shortSide = Math.min(regionWidth, regionHeight);
    const longSide = Math.max(regionWidth, regionHeight);
    const fillRatio = component.pixelCount / (regionWidth * regionHeight);
    const sceneScore = getComponentSceneScore(component);
    const detailScore = getComponentDetailScore(component);
    const protection =
      sceneScore * (0.5 + (1 - cleanupStrength) * 0.35) +
      detailScore * 0.72;
    const effectiveMinRegionPixels = Math.max(
      2,
      Math.round(minRegionPixels * (1 - protection))
    );

    if (
      detailScore > 0.5 &&
      shortSide <= 2 &&
      longSide >= 3 &&
      component.pixelCount >= 2
    ) {
      return false;
    }

    if (
      sceneScore > 0.52 &&
      shortSide <= 2 &&
      longSide >= 4 &&
      component.pixelCount >= Math.max(3, Math.round(effectiveMinRegionPixels * 0.35))
    ) {
      return false;
    }

    return (
      component.pixelCount < effectiveMinRegionPixels ||
      (component.pixelCount < Math.round(effectiveMinRegionPixels * 1.5) &&
        shortSide <= 2) ||
      (component.pixelCount < Math.round(effectiveMinRegionPixels * 1.3) &&
        fillRatio < 0.4)
    );
  };

  const getNeighborColorCounts = (component: Component) => {
    const neighborColorCounts = new Map<number, number>();

    for (const pixelIndex of component.pixels) {
      if (merged[pixelIndex] !== component.paletteIndex) {
        continue;
      }

      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);

      for (const offset of neighborOffsets) {
        const nx = x + offset.dx;
        const ny = y + offset.dy;

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }

        const neighborIndex = ny * width + nx;
        const neighborColor = merged[neighborIndex];

        if (neighborColor === component.paletteIndex) {
          continue;
        }

        neighborColorCounts.set(
          neighborColor,
          (neighborColorCounts.get(neighborColor) ?? 0) + 1
        );
      }
    }

    return neighborColorCounts;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    const components = labelComponents(merged, width, height).sort(
      (left, right) => left.pixelCount - right.pixelCount
    );
    let changed = false;

    for (const component of components) {
      if (merged[component.pixels[0]] !== component.paletteIndex) {
        continue;
      }

      if (!shouldMergeComponent(component)) {
        continue;
      }

      const replacement = Array.from(getNeighborColorCounts(component).entries()).sort(
        (left, right) => right[1] - left[1]
      )[0]?.[0];

      if (replacement === undefined) {
        continue;
      }

      for (const pixelIndex of component.pixels) {
        merged[pixelIndex] = replacement;
      }
      changed = true;
    }

    if (!changed) {
      break;
    }
  }

  return merged;
};

export const smoothPixelAssignments = (
  pixels: Uint8Array,
  width: number,
  height: number,
  cleanupStrength: number,
  sceneMap?: SceneMap,
  detailProtectionMap?: Float32Array
) => {
  if (cleanupStrength <= 0.08) {
    return new Uint8Array(pixels);
  }

  const smoothed = new Uint8Array(pixels);

  for (let pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += 1) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const currentColor = pixels[pixelIndex];
    const sceneScore = sceneMap
      ? sampleSceneScore(sceneMap, x + 0.5, y + 0.5)
      : 0;
    const detailProtection = detailProtectionMap?.[pixelIndex] ?? 0;
    const localCleanupStrength =
      cleanupStrength *
      (1 - sceneScore * 0.82) *
      (1 - detailProtection * 0.9);

    if (localCleanupStrength <= 0.08 || detailProtection >= 0.78) {
      continue;
    }

    const dominantThreshold =
      localCleanupStrength >= 0.65
        ? 5
        : localCleanupStrength >= 0.35
          ? 6
          : 7;
    const marginThreshold =
      localCleanupStrength >= 0.65
        ? 3
        : localCleanupStrength >= 0.35
          ? 4
          : 5;
    const neighborCounts = new Map<number, number>();

    for (const offset of smoothingOffsets) {
      const nx = x + offset.dx;
      const ny = y + offset.dy;

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        continue;
      }

      const neighborIndex = ny * width + nx;
      const neighborColor = pixels[neighborIndex];
      neighborCounts.set(
        neighborColor,
        (neighborCounts.get(neighborColor) ?? 0) + 1
      );
    }

    const currentCount = neighborCounts.get(currentColor) ?? 0;
    const dominantNeighbor = Array.from(neighborCounts.entries()).sort(
      (left, right) => right[1] - left[1]
    )[0];

    if (!dominantNeighbor) {
      continue;
    }

    const [dominantColor, dominantCount] = dominantNeighbor;

    if (
      dominantColor !== currentColor &&
      dominantCount >= dominantThreshold &&
      dominantCount >= currentCount + marginThreshold
    ) {
      smoothed[pixelIndex] = dominantColor;
    }
  }

  return smoothed;
};

const chooseDominantColor = (colorCounts: Map<number, number>) =>
  Array.from(colorCounts.entries()).sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return left[0] - right[0];
  })[0]?.[0];

const collapsePixelBlocks = (
  pixels: Uint8Array,
  width: number,
  height: number,
  blockSize: number,
  sceneMap?: SceneMap,
  detailProtectionMap?: Float32Array
) => {
  const collapsed = new Uint8Array(pixels);

  for (let blockY = 0; blockY < height; blockY += blockSize) {
    for (let blockX = 0; blockX < width; blockX += blockSize) {
      const colorCounts = new Map<number, number>();

      for (
        let y = blockY;
        y < Math.min(height, blockY + blockSize);
        y += 1
      ) {
        for (
          let x = blockX;
          x < Math.min(width, blockX + blockSize);
          x += 1
        ) {
          const pixelIndex = y * width + x;
          const color = pixels[pixelIndex];
          colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
        }
      }

      const dominantColor = chooseDominantColor(colorCounts);
      const blockSceneScore = sceneMap
        ? sampleSceneScore(
            sceneMap,
            blockX + Math.min(blockSize, width - blockX) / 2,
            blockY + Math.min(blockSize, height - blockY) / 2
          )
        : 0;
      let blockDetailScore = 0;

      if (detailProtectionMap) {
        let detailTotal = 0;
        let detailCount = 0;

        for (
          let y = blockY;
          y < Math.min(height, blockY + blockSize);
          y += 1
        ) {
          for (
            let x = blockX;
            x < Math.min(width, blockX + blockSize);
            x += 1
          ) {
            detailTotal += detailProtectionMap[y * width + x];
            detailCount += 1;
          }
        }

        blockDetailScore = detailCount === 0 ? 0 : detailTotal / detailCount;
      }

      if (
        dominantColor === undefined ||
        blockSceneScore > 0.46 ||
        blockDetailScore > 0.34
      ) {
        continue;
      }

      for (
        let y = blockY;
        y < Math.min(height, blockY + blockSize);
        y += 1
      ) {
        for (
          let x = blockX;
          x < Math.min(width, blockX + blockSize);
          x += 1
        ) {
          collapsed[y * width + x] = dominantColor;
        }
      }
    }
  }

  return collapsed;
};

const convergeRegionCount = (
  pixels: Uint8Array,
  width: number,
  height: number,
  minRegionPixels: number,
  targetRegionCount: number,
  cleanupStrength: number,
  sceneMap?: SceneMap,
  detailProtectionMap?: Float32Array
) => {
  let merged = new Uint8Array(pixels);
  let mergeThreshold = minRegionPixels;

  for (let pass = 0; pass < 6; pass += 1) {
    const components = labelComponents(merged, width, height);

    if (components.length <= targetRegionCount) {
      return merged;
    }

    const pressure = components.length / targetRegionCount;
    const thresholdMultiplier =
      pressure >= 6 ? 2.1 : pressure >= 3 ? 1.65 : pressure >= 2 ? 1.4 : 1.2;

    mergeThreshold = Math.max(
      mergeThreshold + 6,
      Math.round(mergeThreshold * thresholdMultiplier)
    );
    merged = mergeSmallRegions(
      merged,
      width,
      height,
      mergeThreshold,
      sceneMap,
      cleanupStrength,
      detailProtectionMap
    );

    const postMergeComponents = labelComponents(merged, width, height);
    const tinyComponentRatio =
      postMergeComponents.filter((component) => component.pixelCount <= 2).length /
      postMergeComponents.length;

    if (
      cleanupStrength > 0.55 &&
      postMergeComponents.length > targetRegionCount * 2.5 &&
      tinyComponentRatio > 0.3
    ) {
      merged = collapsePixelBlocks(
        merged,
        width,
        height,
        2,
        sceneMap,
        detailProtectionMap
      );
      merged = smoothPixelAssignments(
        merged,
        width,
        height,
        cleanupStrength,
        sceneMap,
        detailProtectionMap
      );
      merged = mergeSmallRegions(
        merged,
        width,
        height,
        mergeThreshold,
        sceneMap,
        cleanupStrength,
        detailProtectionMap
      );

      const emergencyComponents = labelComponents(merged, width, height);

      if (emergencyComponents.length > targetRegionCount * 2.2) {
        merged = collapsePixelBlocks(merged, width, height, 2, sceneMap);
        merged = smoothPixelAssignments(
          merged,
          width,
          height,
          cleanupStrength * 0.85,
          sceneMap
        );
        merged = mergeSmallRegions(
          merged,
          width,
          height,
          Math.max(mergeThreshold, Math.round(minRegionPixels * 2.2)),
          sceneMap,
          cleanupStrength * 0.92
        );
      }
    }
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const remainingComponents = labelComponents(merged, width, height);

    if (remainingComponents.length <= targetRegionCount) {
      return merged;
    }

    merged = collapsePixelBlocks(merged, width, height, 2, sceneMap);
    merged = smoothPixelAssignments(
      merged,
      width,
      height,
      cleanupStrength * 0.82,
      sceneMap
    );
    merged = mergeSmallRegions(
      merged,
      width,
      height,
      Math.max(mergeThreshold, Math.round(minRegionPixels * 2.4)),
      sceneMap,
      cleanupStrength * 0.88
    );
  }

  return merged;
};

const chooseLabelPoint = (
  component: Component,
  width: number,
  height: number
) => {
  const localWidth = component.maxX - component.minX + 1;
  const localHeight = component.maxY - component.minY + 1;
  const mask = new Uint8Array(localWidth * localHeight);

  for (const pixelIndex of component.pixels) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const localIndex = (y - component.minY) * localWidth + (x - component.minX);
    mask[localIndex] = 1;
  }

  const distances = new Int16Array(mask.length);
  distances.fill(-1);
  const queue: number[] = [];

  for (let localY = 0; localY < localHeight; localY += 1) {
    for (let localX = 0; localX < localWidth; localX += 1) {
      const localIndex = localY * localWidth + localX;

      if (mask[localIndex] === 0) {
        continue;
      }

      const boundary =
        localX === 0 ||
        localY === 0 ||
        localX === localWidth - 1 ||
        localY === localHeight - 1 ||
        mask[localIndex - 1] === 0 ||
        mask[localIndex + 1] === 0 ||
        mask[localIndex - localWidth] === 0 ||
        mask[localIndex + localWidth] === 0;

      if (boundary) {
        distances[localIndex] = 0;
        queue.push(localIndex);
      }
    }
  }

  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const localX = current % localWidth;
    const localY = Math.floor(current / localWidth);

    for (const offset of neighborOffsets) {
      const nx = localX + offset.dx;
      const ny = localY + offset.dy;

      if (nx < 0 || nx >= localWidth || ny < 0 || ny >= localHeight) {
        continue;
      }

      const neighborIndex = ny * localWidth + nx;

      if (mask[neighborIndex] === 0 || distances[neighborIndex] !== -1) {
        continue;
      }

      distances[neighborIndex] = distances[current] + 1;
      queue.push(neighborIndex);
    }
  }

  const centerX = (component.minX + component.maxX) / 2;
  const centerY = (component.minY + component.maxY) / 2;
  let bestLocalIndex = 0;
  let bestDistance = -1;
  let bestCenterDistance = Number.POSITIVE_INFINITY;

  for (let localIndex = 0; localIndex < mask.length; localIndex += 1) {
    if (mask[localIndex] === 0) {
      continue;
    }

    const localX = localIndex % localWidth;
    const localY = Math.floor(localIndex / localWidth);
    const globalX = component.minX + localX;
    const globalY = component.minY + localY;
    const centerDistance =
      (globalX - centerX) ** 2 + (globalY - centerY) ** 2;

    if (
      distances[localIndex] > bestDistance ||
      (distances[localIndex] === bestDistance &&
        centerDistance < bestCenterDistance)
    ) {
      bestDistance = distances[localIndex];
      bestCenterDistance = centerDistance;
      bestLocalIndex = localIndex;
    }
  }

  return {
    label: {
      x: component.minX + (bestLocalIndex % localWidth) + 0.5,
      y: component.minY + Math.floor(bestLocalIndex / localWidth) + 0.5
    },
    labelRadius: Math.max(1, bestDistance + 0.75)
  };
};

interface Edge {
  start: Point;
  end: Point;
  direction: 0 | 1 | 2 | 3;
}

const simplifyLoop = (loop: Point[]) => {
  const closedLoop = [...loop];

  while (closedLoop.length >= 3) {
    let removedPoint = false;

    for (let index = 0; index < closedLoop.length; index += 1) {
      const previous =
        closedLoop[(index - 1 + closedLoop.length) % closedLoop.length];
      const current = closedLoop[index];
      const next = closedLoop[(index + 1) % closedLoop.length];
      const collinear =
        (previous.x === current.x && current.x === next.x) ||
        (previous.y === current.y && current.y === next.y);

      if (collinear) {
        closedLoop.splice(index, 1);
        removedPoint = true;
        break;
      }
    }

    if (!removedPoint) {
      break;
    }
  }

  return closedLoop;
};

const chooseNextEdge = (edges: Edge[], previousDirection: number) => {
  const rankedTurns = [1, 0, 3];

  return [...edges].sort((left, right) => {
    const leftTurn = (left.direction - previousDirection + 4) % 4;
    const rightTurn = (right.direction - previousDirection + 4) % 4;
    const leftRank = rankedTurns.indexOf(leftTurn);
    const rightRank = rankedTurns.indexOf(rightTurn);
    return (leftRank === -1 ? 99 : leftRank) - (rightRank === -1 ? 99 : rightRank);
  })[0];
};

const traceLoops = (edges: Edge[]) => {
  const byStart = new Map<string, Edge[]>();

  for (const edge of edges) {
    const key = keyForPoint(edge.start);
    const existing = byStart.get(key);

    if (existing) {
      existing.push(edge);
    } else {
      byStart.set(key, [edge]);
    }
  }

  const used = new Set<Edge>();
  const loops: Point[][] = [];

  for (const edge of edges) {
    if (used.has(edge)) {
      continue;
    }

    const loop: Point[] = [edge.start];
    let current = edge;
    used.add(current);
    loop.push(current.end);

    while (keyForPoint(current.end) !== keyForPoint(loop[0])) {
      const candidates =
        byStart
          .get(keyForPoint(current.end))
          ?.filter((candidate) => !used.has(candidate)) ?? [];

      if (candidates.length === 0) {
        break;
      }

      const next = chooseNextEdge(candidates, current.direction);
      used.add(next);
      loop.push(next.end);
      current = next;
    }

    if (loop.length >= 4) {
      const simplified = simplifyLoop(loop.slice(0, -1));
      if (simplified.length >= 4) {
        loops.push(simplified);
      }
    }
  }

  return loops;
};

const extractLoops = (
  component: Component,
  width: number
) => {
  const membership = new Set(component.pixels);
  const edges: Edge[] = [];

  for (const pixelIndex of component.pixels) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const top = pixelIndex - width;
    const right = pixelIndex + 1;
    const bottom = pixelIndex + width;
    const left = pixelIndex - 1;

    if (!membership.has(top)) {
      edges.push({
        start: { x, y },
        end: { x: x + 1, y },
        direction: 0
      });
    }

    if (!membership.has(right) || x === width - 1) {
      edges.push({
        start: { x: x + 1, y },
        end: { x: x + 1, y: y + 1 },
        direction: 1
      });
    }

    if (!membership.has(bottom)) {
      edges.push({
        start: { x: x + 1, y: y + 1 },
        end: { x, y: y + 1 },
        direction: 2
      });
    }

    if (!membership.has(left) || x === 0) {
      edges.push({
        start: { x, y: y + 1 },
        end: { x, y },
        direction: 3
      });
    }
  }

  return traceLoops(edges);
};

const chooseDetailWindows = (
  width: number,
  height: number,
  regions: PatternRegion[],
  options: PatternOptions
) => {
  const windows: DetailWindow[] = [];
  const tileWidth = width / options.detailGrid;
  const tileHeight = height / options.detailGrid;
  const scoredTiles: DetailWindow[] = [];

  for (let row = 0; row < options.detailGrid; row += 1) {
    for (let column = 0; column < options.detailGrid; column += 1) {
      const x = Math.round(column * tileWidth);
      const y = Math.round(row * tileHeight);
      const windowWidth = Math.round(
        column === options.detailGrid - 1 ? width - x : tileWidth
      );
      const windowHeight = Math.round(
        row === options.detailGrid - 1 ? height - y : tileHeight
      );
      const regionCount = regions.filter((region) => {
        const withinX = region.label.x >= x && region.label.x < x + windowWidth;
        const withinY = region.label.y >= y && region.label.y < y + windowHeight;
        return withinX && withinY;
      }).length;

      scoredTiles.push({
        id: `${row}-${column}`,
        title: `Detail ${String.fromCharCode(65 + scoredTiles.length)}`,
        x,
        y,
        width: windowWidth,
        height: windowHeight,
        regionCount
      });
    }
  }

  const totalRegions = regions.length;
  const threshold = Math.max(14, Math.round(totalRegions / 9));

  for (const tile of scoredTiles
    .filter((tile) => tile.regionCount >= threshold)
    .sort((left, right) => right.regionCount - left.regionCount)
    .slice(0, options.maxDetailPages)) {
    windows.push(tile);
  }

  if (windows.length === 0 && totalRegions > 100) {
    const densestTile = scoredTiles.sort(
      (left, right) => right.regionCount - left.regionCount
    )[0];
    if (densestTile) {
      windows.push(densestTile);
    }
  }

  return windows;
};

export const createPatternFromImageData = (
  imageData: ImageData,
  overrides: Partial<PatternOptions> = {},
  originalSize = {
    width: imageData.width,
    height: imageData.height
  }
): PatternDocument => {
  const options = { ...DEFAULT_PATTERN_OPTIONS, ...overrides };
  const imageProfile = analyzeImageProfile(imageData, options.paletteSize);
  const rawDetailProtectionMap = computeDetailProtectionMap(
    imageData,
    imageProfile
  );
  const detailProtectionMap = strengthenArtworkLineProtection(
    imageData,
    imageProfile,
    rawDetailProtectionMap
  );
  const lineworkStrokeMask = buildLineworkStrokeMask(
    imageData,
    detailProtectionMap,
    0
  );
  const lineworkStrokePixels = countStrokeMaskPixels(lineworkStrokeMask);
  const hasDedicatedArtworkLinework =
    imageProfile.renderingMode === 'artwork' &&
    lineworkStrokePixels >=
      Math.max(10, Math.round(lineworkStrokeMask.length * 0.006));
  const workingImageData = normalizeArtworkBackground(
    imageData,
    imageProfile,
    detailProtectionMap
  );
  const effectiveOptions = {
    ...options,
    paletteSize: Math.min(
      options.paletteSize,
      imageProfile.effectivePaletteSize + (hasDedicatedArtworkLinework ? 1 : 0)
    ),
    minRegionPixels: Math.max(
      hasDedicatedArtworkLinework ? 1 : 2,
      Math.round(
        options.minRegionPixels *
          imageProfile.minRegionScale *
          (imageProfile.renderingMode === 'artwork' ? 0.74 : 1)
      )
    ),
    targetRegionCount: Math.max(
      24,
      Math.round(
        options.targetRegionCount *
          imageProfile.targetRegionScale *
          (imageProfile.renderingMode === 'artwork' ? 1.45 : 1)
      )
    ),
    cleanupStrength: clamp01(
      options.cleanupStrength *
        imageProfile.cleanupStrengthScale *
        (imageProfile.renderingMode === 'artwork' ? 0.55 : 1)
    )
  };
  const sceneMap = analyzeSceneMap(workingImageData);
  const quantized = quantizeImageData(
    workingImageData,
    effectiveOptions,
    imageProfile,
    detailProtectionMap
  );
  const quantizedLinePaletteIndex = chooseArtworkLinePaletteIndex(
    quantized.palette,
    imageProfile
  );
  const protectedQuantized =
    quantizedLinePaletteIndex !== undefined
      ? {
          ...quantized,
          strokePaletteIndex: quantizedLinePaletteIndex,
          strokeMask: buildPaletteIndexMask(
            quantized.pixels,
            quantizedLinePaletteIndex
          )
        }
      : reserveLineworkStrokePaletteSlot(
          workingImageData,
          quantized,
          imageProfile,
          detailProtectionMap
        );
  const fallbackLinePaletteIndex = chooseArtworkLinePaletteIndex(
    protectedQuantized.palette,
    imageProfile
  );
  const fallbackLineMask = buildPaletteIndexMask(
    protectedQuantized.pixels,
    fallbackLinePaletteIndex
  );
  const preserveDirectIllustrationLinework =
    imageProfile.renderingMode === 'artwork' &&
    fallbackLinePaletteIndex !== undefined &&
    protectedQuantized.palette.length <= Math.min(6, options.paletteSize) &&
    imageProfile.flatArtworkScore > 0.45;
  const smoothed = preserveDirectIllustrationLinework
    ? new Uint8Array(protectedQuantized.pixels)
    : smoothPixelAssignments(
        protectedQuantized.pixels,
        workingImageData.width,
        workingImageData.height,
        effectiveOptions.cleanupStrength,
        sceneMap,
        detailProtectionMap
      );
  const pixels = preserveDirectIllustrationLinework
    ? smoothed
    : mergeSmallRegions(
        smoothed,
        workingImageData.width,
        workingImageData.height,
        effectiveOptions.minRegionPixels,
        sceneMap,
        effectiveOptions.cleanupStrength,
        detailProtectionMap
      );
  const convergedPixels = preserveDirectIllustrationLinework
    ? pixels
    : convergeRegionCount(
        pixels,
        workingImageData.width,
        workingImageData.height,
        effectiveOptions.minRegionPixels,
        effectiveOptions.targetRegionCount,
        effectiveOptions.cleanupStrength,
        sceneMap,
        detailProtectionMap
      );
  const lineReinforcedPixels = reinforceStrokePixels(
    convergedPixels,
    mergeMasks(protectedQuantized.strokeMask, fallbackLineMask),
    protectedQuantized.strokePaletteIndex ?? fallbackLinePaletteIndex
  );
  const normalized = mergeSimilarPaletteEntries(
    protectedQuantized.palette,
    lineReinforcedPixels,
    imageProfile.paletteMergeDistance
  );
  const components = labelComponents(
    normalized.pixels,
    workingImageData.width,
    workingImageData.height
  );
  const regions: PatternRegion[] = components.map((component, index) => {
    const { label, labelRadius } = chooseLabelPoint(
      component,
      workingImageData.width,
      workingImageData.height
    );
    const loops = extractLoops(component, workingImageData.width);

    return {
      id: index,
      paletteIndex: component.paletteIndex,
      paletteNumber: component.paletteIndex + 1,
      pixelCount: component.pixelCount,
      bbox: {
        x: component.minX,
        y: component.minY,
        width: component.maxX - component.minX + 1,
        height: component.maxY - component.minY + 1
      },
      label,
      labelRadius,
      loops,
      path: buildPathString(loops)
    };
  });

  return {
    width: workingImageData.width,
    height: workingImageData.height,
    originalWidth: originalSize.width,
    originalHeight: originalSize.height,
    palette: normalized.palette,
    pixels: normalized.pixels,
    regions,
    detailWindows: chooseDetailWindows(
      workingImageData.width,
      workingImageData.height,
      regions,
      effectiveOptions
    )
  };
};

export const generatePattern = async (
  file: File,
  overrides: Partial<PatternOptions> = {}
) => {
  const options = { ...DEFAULT_PATTERN_OPTIONS, ...overrides };
  const loaded = await loadFileToImageData(file, options.workingMaxDimension);
  return createPatternFromImageData(
    loaded.imageData,
    options,
    {
      width: loaded.originalWidth,
      height: loaded.originalHeight
    }
  );
};

export const patternDefaults = DEFAULT_PATTERN_OPTIONS;
