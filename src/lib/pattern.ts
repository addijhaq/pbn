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

const keyForPoint = (point: Point) => `${point.x},${point.y}`;

export const buildPathString = (loops: Point[][]) =>
  loops
    .map(
      (loop) =>
        loop
          .map(
            (point, index) =>
              `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`
          )
          .join(' ') + ' Z'
    )
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
  sampleIndices: number[],
  labs: Float32Array,
  centroids: Float32Array,
  centroidCount: number
) => {
  let bestIndex = sampleIndices[0] ?? 0;
  let bestDistance = -1;

  for (const sampleIndex of sampleIndices) {
    const offset = sampleIndex * 3;
    const lab = {
      l: labs[offset],
      a: labs[offset + 1],
      b: labs[offset + 2]
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

    if (nearest > bestDistance) {
      bestDistance = nearest;
      bestIndex = sampleIndex;
    }
  }

  return bestIndex;
};

export const quantizeImageData = (
  imageData: ImageData,
  options: PatternOptions
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
  const centroidCount = options.paletteSize;
  const centroids = new Float32Array(centroidCount * 3);

  if (sampleIndices.length === 0) {
    throw new Error('The uploaded image does not contain any pixels.');
  }

  const firstSampleOffset = sampleIndices[0] * 3;
  centroids[0] = labs[firstSampleOffset];
  centroids[1] = labs[firstSampleOffset + 1];
  centroids[2] = labs[firstSampleOffset + 2];

  for (let centroidIndex = 1; centroidIndex < centroidCount; centroidIndex += 1) {
    const sampleIndex = farthestSampleIndex(
      sampleIndices,
      labs,
      centroids,
      centroidIndex
    );
    const sourceOffset = sampleIndex * 3;
    const centroidOffset = centroidIndex * 3;
    centroids[centroidOffset] = labs[sourceOffset];
    centroids[centroidOffset + 1] = labs[sourceOffset + 1];
    centroids[centroidOffset + 2] = labs[sourceOffset + 2];
  }

  for (let iteration = 0; iteration < options.maxKMeansIterations; iteration += 1) {
    const sums = new Float32Array(centroidCount * 3);
    const counts = new Uint32Array(centroidCount);

    for (const sampleIndex of sampleIndices) {
      const offset = sampleIndex * 3;
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

      const sumOffset = nearestCentroid * 3;
      sums[sumOffset] += labs[offset];
      sums[sumOffset + 1] += labs[offset + 1];
      sums[sumOffset + 2] += labs[offset + 2];
      counts[nearestCentroid] += 1;
    }

    for (let centroidIndex = 0; centroidIndex < centroidCount; centroidIndex += 1) {
      const centroidOffset = centroidIndex * 3;

      if (counts[centroidIndex] === 0) {
        const replacementIndex = sampleIndices[(centroidIndex * 487) % sampleIndices.length];
        const sourceOffset = replacementIndex * 3;
        centroids[centroidOffset] = labs[sourceOffset];
        centroids[centroidOffset + 1] = labs[sourceOffset + 1];
        centroids[centroidOffset + 2] = labs[sourceOffset + 2];
        continue;
      }

      centroids[centroidOffset] = sums[centroidOffset] / counts[centroidIndex];
      centroids[centroidOffset + 1] = sums[centroidOffset + 1] / counts[centroidIndex];
      centroids[centroidOffset + 2] = sums[centroidOffset + 2] / counts[centroidIndex];
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
  minRegionPixels: number
) => {
  const merged = new Uint8Array(pixels);

  const shouldMergeComponent = (component: Component) => {
    const regionWidth = component.maxX - component.minX + 1;
    const regionHeight = component.maxY - component.minY + 1;
    const shortSide = Math.min(regionWidth, regionHeight);
    const fillRatio = component.pixelCount / (regionWidth * regionHeight);

    return (
      component.pixelCount < minRegionPixels ||
      (component.pixelCount < Math.round(minRegionPixels * 1.5) &&
        shortSide <= 2) ||
      (component.pixelCount < Math.round(minRegionPixels * 1.3) &&
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
  cleanupStrength: number
) => {
  if (cleanupStrength <= 0.08) {
    return new Uint8Array(pixels);
  }

  const smoothed = new Uint8Array(pixels);
  const dominantThreshold = cleanupStrength >= 0.65 ? 5 : cleanupStrength >= 0.35 ? 6 : 7;
  const marginThreshold = cleanupStrength >= 0.65 ? 3 : cleanupStrength >= 0.35 ? 4 : 5;

  for (let pixelIndex = 0; pixelIndex < pixels.length; pixelIndex += 1) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const currentColor = pixels[pixelIndex];
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
  blockSize: number
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

      if (dominantColor === undefined) {
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
  cleanupStrength: number
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
    merged = mergeSmallRegions(merged, width, height, mergeThreshold);

    const postMergeComponents = labelComponents(merged, width, height);
    const tinyComponentRatio =
      postMergeComponents.filter((component) => component.pixelCount <= 2).length /
      postMergeComponents.length;

    if (
      cleanupStrength > 0.55 &&
      postMergeComponents.length > targetRegionCount * 2.5 &&
      tinyComponentRatio > 0.3
    ) {
      merged = collapsePixelBlocks(merged, width, height, 2);
      merged = smoothPixelAssignments(merged, width, height, cleanupStrength);
      merged = mergeSmallRegions(merged, width, height, mergeThreshold);
    }
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
  const quantized = quantizeImageData(imageData, options);
  const smoothed = smoothPixelAssignments(
    quantized.pixels,
    imageData.width,
    imageData.height,
    options.cleanupStrength
  );
  const pixels = mergeSmallRegions(
    smoothed,
    imageData.width,
    imageData.height,
    options.minRegionPixels
  );
  const convergedPixels = convergeRegionCount(
    pixels,
    imageData.width,
    imageData.height,
    options.minRegionPixels,
    options.targetRegionCount,
    options.cleanupStrength
  );
  const components = labelComponents(
    convergedPixels,
    imageData.width,
    imageData.height
  );
  const regions: PatternRegion[] = components.map((component, index) => {
    const { label, labelRadius } = chooseLabelPoint(
      component,
      imageData.width,
      imageData.height
    );
    const loops = extractLoops(component, imageData.width);

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
    width: imageData.width,
    height: imageData.height,
    originalWidth: originalSize.width,
    originalHeight: originalSize.height,
    palette: quantized.palette,
    pixels: convergedPixels,
    regions,
    detailWindows: chooseDetailWindows(
      imageData.width,
      imageData.height,
      regions,
      options
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
