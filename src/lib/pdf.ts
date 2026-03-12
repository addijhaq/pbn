import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { canvasToPngBytes, renderOutlineCanvas, renderReferenceCanvas } from './render';
import type {
  Bounds,
  PageSize,
  PatternDocument,
  PdfAssets,
  PdfExportOptions,
  PatternRegion,
  Point
} from './types';

const pageSizes: Record<PageSize, { width: number; height: number }> = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 }
};

const paperColor = rgb(0.992, 0.976, 0.949);
const inkColor = rgb(0.118, 0.094, 0.078);

const buildPdfPath = (loops: Point[][], documentHeight: number) =>
  loops
    .map(
      (loop) =>
        loop
          .map((point, index) => {
            const command = index === 0 ? 'M' : 'L';
            return `${command}${point.x} ${documentHeight - point.y}`;
          })
          .join(' ') + ' Z'
    )
    .join(' ');

const drawPageFrame = (
  page: PDFPage,
  title: string,
  subtitle: string,
  titleFont: PDFFont,
  bodyFont: PDFFont
) => {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();

  page.drawRectangle({
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
    color: paperColor
  });

  page.drawText(title, {
    x: 40,
    y: pageHeight - 44,
    size: 20,
    color: inkColor,
    font: titleFont
  });

  page.drawText(subtitle, {
    x: 40,
    y: pageHeight - 62,
    size: 10,
    color: rgb(0.33, 0.29, 0.24),
    font: bodyFont
  });

  page.drawRectangle({
    x: 28,
    y: 28,
    width: pageWidth - 56,
    height: pageHeight - 56,
    borderColor: rgb(0.77, 0.72, 0.66),
    borderWidth: 1
  });
};

const fitIntoFrame = (
  contentWidth: number,
  contentHeight: number,
  frame: Bounds
) => {
  const scale = Math.min(frame.width / contentWidth, frame.height / contentHeight);
  const width = contentWidth * scale;
  const height = contentHeight * scale;

  return {
    scale,
    x: frame.x + (frame.width - width) / 2,
    y: frame.y + (frame.height - height) / 2,
    width,
    height
  };
};

const getRegionFontSize = (region: PatternRegion, scale: number) =>
  Math.max(6, Math.min(16, region.labelRadius * 1.6 * scale));

const drawVectorPattern = (
  page: PDFPage,
  pattern: PatternDocument,
  frame: Bounds,
  font: PDFFont
) => {
  const placement = fitIntoFrame(pattern.width, pattern.height, frame);

  for (const region of pattern.regions) {
    if (!region.loops.length) {
      continue;
    }

    page.drawSvgPath(buildPdfPath(region.loops, pattern.height), {
      x: placement.x,
      y: placement.y,
      scale: placement.scale,
      borderColor: inkColor,
      borderWidth: 0.55
    });
  }

  for (const region of pattern.regions) {
    const size = getRegionFontSize(region, placement.scale);
    const label = String(region.paletteNumber);
    const labelWidth = font.widthOfTextAtSize(label, size);

    page.drawText(label, {
      x: placement.x + region.label.x * placement.scale - labelWidth / 2,
      y:
        placement.y +
        (pattern.height - region.label.y) * placement.scale -
        size * 0.35,
      size,
      color: inkColor,
      font
    });
  }
};

const drawPalettePage = (
  page: PDFPage,
  pattern: PatternDocument,
  font: PDFFont
) => {
  const columns = 2;
  const rows = 10;
  const gutter = 18;
  const cardWidth = (page.getWidth() - 80 - gutter) / columns;
  const cardHeight = (page.getHeight() - 140) / rows;

  pattern.palette.forEach((entry, index) => {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const x = 40 + column * (cardWidth + gutter);
    const y = page.getHeight() - 110 - row * cardHeight;
    const fill = rgb(
      entry.rgb[0] / 255,
      entry.rgb[1] / 255,
      entry.rgb[2] / 255
    );

    page.drawRectangle({
      x,
      y: y - 18,
      width: 28,
      height: 28,
      color: fill,
      borderColor: inkColor,
      borderWidth: 0.7
    });

    page.drawText(String(entry.number).padStart(2, '0'), {
      x: x + 40,
      y: y - 1,
      size: 11,
      color: inkColor,
      font
    });

    page.drawText(entry.hex.toUpperCase(), {
      x: x + 78,
      y: y - 1,
      size: 10,
      color: rgb(0.32, 0.28, 0.24),
      font
    });
  });
};

const drawEmbeddedImagePage = async (
  pdf: PDFDocument,
  page: PDFPage,
  pngBytes: Uint8Array,
  frame: Bounds
) => {
  const image = await pdf.embedPng(pngBytes);
  const placement = fitIntoFrame(image.width, image.height, frame);

  page.drawImage(image, {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height
  });
};

export const preparePdfAssets = async (
  pattern: PatternDocument
): Promise<PdfAssets> => {
  const referenceCanvas = renderReferenceCanvas(pattern, 4);
  const referencePng = await canvasToPngBytes(referenceCanvas);
  const detailPngs: Record<string, Uint8Array> = {};

  for (const detailWindow of pattern.detailWindows) {
    const detailCanvas = renderOutlineCanvas(pattern, 10, detailWindow);
    detailPngs[detailWindow.id] = await canvasToPngBytes(detailCanvas);
  }

  return {
    referencePng,
    detailPngs
  };
};

export const buildPdfBytes = async (
  pattern: PatternDocument,
  assets: PdfAssets,
  options: PdfExportOptions
) => {
  const size = pageSizes[options.pageSize];
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const title = options.title ?? 'Paint by Numbers Workbook';
  const subtitle = `${pattern.originalWidth} x ${pattern.originalHeight} photo -> ${pattern.palette.length} numbered colors`;

  const outlinePage = pdf.addPage([size.width, size.height]);
  drawPageFrame(outlinePage, title, subtitle, boldFont, font);
  drawVectorPattern(outlinePage, pattern, {
    x: 44,
    y: 54,
    width: size.width - 88,
    height: size.height - 126
  }, font);

  const palettePage = pdf.addPage([size.width, size.height]);
  drawPageFrame(palettePage, title, 'Palette guide', boldFont, font);
  drawPalettePage(palettePage, pattern, font);

  const referencePage = pdf.addPage([size.width, size.height]);
  drawPageFrame(
    referencePage,
    title,
    'Simplified color reference',
    boldFont,
    font
  );
  await drawEmbeddedImagePage(pdf, referencePage, assets.referencePng, {
    x: 44,
    y: 54,
    width: size.width - 88,
    height: size.height - 126
  });

  for (const detailWindow of pattern.detailWindows) {
    const page = pdf.addPage([size.width, size.height]);
    drawPageFrame(page, title, detailWindow.title, boldFont, font);
    const detailPng = assets.detailPngs[detailWindow.id];

    if (detailPng) {
      await drawEmbeddedImagePage(pdf, page, detailPng, {
        x: 44,
        y: 54,
        width: size.width - 88,
        height: size.height - 126
      });
    }
  }

  return pdf.save();
};

export const exportPatternPdf = async (
  pattern: PatternDocument,
  options: PdfExportOptions
) => {
  const assets = await preparePdfAssets(pattern);
  const pdfBytes = await buildPdfBytes(pattern, assets, options);
  const copy = new Uint8Array(pdfBytes.byteLength);
  copy.set(pdfBytes);
  return new Blob([copy.buffer], { type: 'application/pdf' });
};
