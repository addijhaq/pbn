import {
  createPatternOptionsFromControls,
  defaultPatternControls,
  describeDetailLevel
} from './settings';

describe('createPatternOptionsFromControls', () => {
  it('maps low detail settings to stronger simplification', () => {
    const lowDetail = createPatternOptionsFromControls({
      paletteSize: 12,
      detailLevel: 1
    });
    const highDetail = createPatternOptionsFromControls({
      paletteSize: 12,
      detailLevel: 100
    });

    expect(lowDetail.workingMaxDimension).toBeLessThan(highDetail.workingMaxDimension);
    expect(lowDetail.minRegionPixels).toBeGreaterThan(highDetail.minRegionPixels);
    expect(lowDetail.targetRegionCount).toBeLessThan(highDetail.targetRegionCount);
    expect(lowDetail.cleanupStrength).toBeGreaterThan(highDetail.cleanupStrength);
  });

  it('uses the configured default controls', () => {
    const defaults = createPatternOptionsFromControls(defaultPatternControls);

    expect(defaults.paletteSize).toBe(defaultPatternControls.paletteSize);
    expect(defaults.targetRegionCount).toBeGreaterThan(320);
  });
});

describe('describeDetailLevel', () => {
  it('returns readable labels for slider buckets', () => {
    expect(describeDetailLevel(10)).toBe('Smooth');
    expect(describeDetailLevel(40)).toBe('Balanced');
    expect(describeDetailLevel(70)).toBe('Sharper');
    expect(describeDetailLevel(90)).toBe('Fine');
  });
});
