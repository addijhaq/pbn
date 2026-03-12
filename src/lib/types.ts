export type PageSize = 'letter' | 'a4';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaletteEntry {
  index: number;
  number: number;
  rgb: [number, number, number];
  hex: string;
  label: string;
  lightness: number;
  usage: number;
}

export interface PatternRegion {
  id: number;
  paletteIndex: number;
  paletteNumber: number;
  pixelCount: number;
  bbox: Bounds;
  label: Point;
  labelRadius: number;
  loops: Point[][];
  path: string;
}

export interface DetailWindow extends Bounds {
  id: string;
  title: string;
  regionCount: number;
}

export interface PatternDocument {
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  palette: PaletteEntry[];
  pixels: Uint8Array;
  regions: PatternRegion[];
  detailWindows: DetailWindow[];
}

export interface PatternOptions {
  paletteSize: number;
  workingMaxDimension: number;
  minRegionPixels: number;
  maxKMeansIterations: number;
  maxDetailPages: number;
  detailGrid: number;
  targetRegionCount: number;
  cleanupStrength: number;
}

export interface PdfAssets {
  referencePng: Uint8Array;
  detailPngs: Record<string, Uint8Array>;
}

export interface PdfExportOptions {
  pageSize: PageSize;
  title?: string;
}
