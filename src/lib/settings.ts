import { patternDefaults } from './pattern';
import type { PatternOptions } from './types';

export interface PatternControls {
  paletteSize: number;
  detailLevel: number;
}

export const paletteSliderRange = {
  min: 8,
  max: 21
} as const;

export const detailSliderRange = {
  min: 1,
  max: 100
} as const;

export const defaultPatternControls: PatternControls = {
  paletteSize: patternDefaults.paletteSize,
  detailLevel: 60
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const describeDetailLevel = (detailLevel: number) => {
  if (detailLevel <= 25) {
    return 'Smooth';
  }

  if (detailLevel <= 50) {
    return 'Balanced';
  }

  if (detailLevel <= 75) {
    return 'Sharper';
  }

  return 'Fine';
};

export const createPatternOptionsFromControls = (
  controls: PatternControls
): PatternOptions => {
  const paletteSize = clamp(
    Math.round(controls.paletteSize),
    paletteSliderRange.min,
    paletteSliderRange.max
  );
  const detailLevel = clamp(
    Math.round(controls.detailLevel),
    detailSliderRange.min,
    detailSliderRange.max
  );
  const detailRatio =
    (detailLevel - detailSliderRange.min) /
    (detailSliderRange.max - detailSliderRange.min);
  const cleanupStrength = Math.max(0, 1 - detailRatio * 1.15);

  return {
    paletteSize,
    workingMaxDimension: Math.round(280 + detailRatio * 260),
    minRegionPixels: Math.round(54 - detailRatio * 42),
    maxKMeansIterations: Math.round(14 + detailRatio * 5),
    maxDetailPages: Math.round(3 + detailRatio * 4),
    detailGrid: detailRatio >= 0.55 ? 4 : 3,
    targetRegionCount: Math.round(320 + detailRatio * 1280),
    cleanupStrength
  };
};
