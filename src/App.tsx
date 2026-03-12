import { ChangeEvent, useEffect, useState, useTransition } from 'react';
import { exportPatternPdf } from './lib/pdf';
import { generatePattern } from './lib/pattern';
import { getRegionFontSize, renderReferenceCanvas } from './lib/render';
import {
  createPatternOptionsFromControls,
  defaultPatternControls,
  describeDetailLevel,
  detailSliderRange,
  paletteSliderRange
} from './lib/settings';
import type { PageSize, PatternDocument } from './lib/types';

const pageSizeLabels: Record<PageSize, string> = {
  letter: 'US Letter',
  a4: 'A4'
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [originalPreview, setOriginalPreview] = useState<string | null>(null);
  const [pattern, setPattern] = useState<PatternDocument | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [paletteSize, setPaletteSize] = useState(defaultPatternControls.paletteSize);
  const [detailLevel, setDetailLevel] = useState(defaultPatternControls.detailLevel);
  const [lastGeneratedControls, setLastGeneratedControls] = useState(defaultPatternControls);
  const [pageSize, setPageSize] = useState<PageSize>('letter');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const currentOptions = createPatternOptionsFromControls({
    paletteSize,
    detailLevel
  });
  const detailDescription = describeDetailLevel(detailLevel);
  const isPatternStale =
    pattern !== null &&
    (lastGeneratedControls.paletteSize !== paletteSize ||
      lastGeneratedControls.detailLevel !== detailLevel);

  useEffect(() => {
    if (!selectedFile) {
      setOriginalPreview(null);
      return;
    }

    const url = URL.createObjectURL(selectedFile);
    setOriginalPreview(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [selectedFile]);

  useEffect(() => {
    if (!pattern) {
      setReferencePreview(null);
      return;
    }

    const canvas = renderReferenceCanvas(pattern, 4);
    setReferencePreview(canvas.toDataURL('image/png'));
  }, [pattern]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setPattern(null);
    setLastGeneratedControls({
      paletteSize,
      detailLevel
    });
    setErrorMessage(null);
  };

  const handlePaletteSizeChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPaletteSize(event.target.valueAsNumber);
    setErrorMessage(null);
  };

  const handleDetailLevelChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDetailLevel(event.target.valueAsNumber);
    setErrorMessage(null);
  };

  const handleGenerate = async () => {
    if (!selectedFile) {
      return;
    }

    setIsGenerating(true);
    setErrorMessage(null);

    try {
      const generated = await generatePattern(selectedFile, currentOptions);
      startTransition(() => {
        setPattern(generated);
        setLastGeneratedControls({
          paletteSize,
          detailLevel
        });
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Pattern generation failed.'
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = async () => {
    if (!pattern || isPatternStale) {
      return;
    }

    setIsExporting(true);
    setErrorMessage(null);

    try {
      const pdfBlob = await exportPatternPdf(pattern, {
        pageSize,
        title: selectedFile
          ? `${selectedFile.name.replace(/\.[^.]+$/, '')} Workbook`
          : 'Paint by Numbers Workbook'
      });

      downloadBlob(
        pdfBlob,
        `${selectedFile?.name.replace(/\.[^.]+$/, '') ?? 'paint-by-numbers'}-${pageSize}.pdf`
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'PDF export failed.'
      );
    } finally {
      setIsExporting(false);
    }
  };

  const totalPages = pattern ? 3 + pattern.detailWindows.length : 0;
  const regionDisplay = pattern ? pattern.regions.length : `~${currentOptions.targetRegionCount}`;
  const generateButtonLabel = isGenerating
    ? 'Generating pattern...'
    : pattern
      ? 'Regenerate numbered outline'
      : 'Generate numbered outline';

  return (
    <div className="app-shell">
      <div className="backdrop backdrop-one" />
      <div className="backdrop backdrop-two" />

      <main className="layout">
        <section className="hero card">
          <div>
            <p className="eyebrow">Photo to Printable Workbook</p>
            <h1>Paint by numbers from a single upload.</h1>
          </div>
          <p className="hero-copy">
            Upload a photo, tune the color count and detail level, collapse
            micro-regions into cleaner paintable cells, and export a printable
            PDF workbook.
          </p>
        </section>

        <section className="workspace">
          <aside className="card control-panel">
            <div className="section-heading">
              <span>01</span>
              <h2>Build the pattern</h2>
            </div>

            <label className="upload-label" htmlFor="image-upload">
              <span className="upload-title">Choose a photo</span>
              <span className="upload-subtitle">
                JPG, PNG, or HEIC files selected from your device
              </span>
            </label>
            <input
              id="image-upload"
              className="file-input"
              type="file"
              accept="image/*"
              onChange={handleFileChange}
            />

            <div className="range-field">
              <div className="range-header">
                <label htmlFor="palette-slider">Number of colors</label>
                <strong>{paletteSize}</strong>
              </div>
              <input
                id="palette-slider"
                className="range-input"
                type="range"
                min={paletteSliderRange.min}
                max={paletteSliderRange.max}
                step={1}
                value={paletteSize}
                onChange={handlePaletteSizeChange}
              />
              <div className="range-meta">
                <span>{paletteSliderRange.min}</span>
                <span>More paint colors</span>
                <span>{paletteSliderRange.max}</span>
              </div>
            </div>

            <div className="range-field">
              <div className="range-header">
                <label htmlFor="detail-slider">Level of detail</label>
                <strong>{detailDescription}</strong>
              </div>
              <input
                id="detail-slider"
                className="range-input"
                type="range"
                min={detailSliderRange.min}
                max={detailSliderRange.max}
                step={1}
                value={detailLevel}
                onChange={handleDetailLevelChange}
              />
              <div className="range-meta">
                <span>Smoother</span>
                <span>Target max regions: {currentOptions.targetRegionCount}</span>
                <span>Sharper</span>
              </div>
            </div>

            <button
              className="primary-button"
              type="button"
              onClick={handleGenerate}
              disabled={!selectedFile || isGenerating}
            >
              {generateButtonLabel}
            </button>

            <div className="section-heading">
              <span>02</span>
              <h2>Export settings</h2>
            </div>

            <div className="toggle-group" role="radiogroup" aria-label="PDF page size">
              {(['letter', 'a4'] as const).map((size) => (
                <button
                  key={size}
                  type="button"
                  className={size === pageSize ? 'toggle-button active' : 'toggle-button'}
                  onClick={() => setPageSize(size)}
                >
                  {pageSizeLabels[size]}
                </button>
              ))}
            </div>

            <button
              className="secondary-button"
              type="button"
              onClick={handleExport}
              disabled={!pattern || isPatternStale || isExporting}
            >
              {isExporting ? 'Building PDF...' : 'Download workbook PDF'}
            </button>

            {isPatternStale ? (
              <p className="stale-note">
                Settings changed. Regenerate before exporting so the preview and
                PDF match.
              </p>
            ) : null}

            {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

            <div className="mini-note">
              The workbook includes the numbered outline, a palette page, a
              color reference page, and automatic zoomed detail sheets for
              denser areas while converging very small sections into cleaner
              regions.
            </div>
          </aside>

          <section className="canvas-column">
            <div className="stats-grid">
              <article className="stat-card card">
                <span className="stat-label">Palette</span>
                <strong>{paletteSize} Colors</strong>
              </article>
              <article className="stat-card card">
                <span className="stat-label">Detail</span>
                <strong>{detailDescription}</strong>
              </article>
              <article className="stat-card card">
                <span className="stat-label">Regions</span>
                <strong>{regionDisplay}</strong>
              </article>
            </div>

            {pattern ? (
              <>
                <div className="preview-grid">
                  <article className="preview-paper card">
                    <div className="paper-header">
                      <span>Original Photo</span>
                    </div>
                    {originalPreview ? (
                      <img
                        className="preview-image"
                        src={originalPreview}
                        alt="Uploaded source"
                      />
                    ) : null}
                  </article>

                  <article className="preview-paper card">
                    <div className="paper-header">
                      <span>{pattern.palette.length}-Color Reference</span>
                    </div>
                    {referencePreview ? (
                      <img
                        className="preview-image"
                        src={referencePreview}
                        alt="Simplified color preview"
                      />
                    ) : null}
                  </article>
                </div>

                <article className="preview-paper card outline-panel">
                  <div className="paper-header">
                    <span>Numbered Outline</span>
                    <small>
                      {isPatternStale
                        ? 'Preview is out of date. Regenerate to apply the new sliders.'
                        : `${pageSizeLabels[pageSize]} export with ${totalPages} workbook page${totalPages === 1 ? '' : 's'}`}
                    </small>
                  </div>

                  <svg
                    className="outline-svg"
                    viewBox={`0 0 ${pattern.width} ${pattern.height}`}
                    role="img"
                    aria-label="Generated paint-by-numbers outline"
                  >
                    <rect
                      x="0"
                      y="0"
                      width={pattern.width}
                      height={pattern.height}
                      fill="#fffdf8"
                    />
                    {pattern.regions.map((region) =>
                      region.path ? (
                        <path
                          key={`path-${region.id}`}
                          d={region.path}
                          fill="none"
                          stroke="#1e1813"
                          strokeWidth="0.55"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      ) : null
                    )}
                    {pattern.regions.map((region) => (
                      <text
                        key={`label-${region.id}`}
                        x={region.label.x}
                        y={region.label.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={getRegionFontSize(region)}
                        fontWeight="700"
                        fontFamily="Georgia, serif"
                        fill="#1e1813"
                      >
                        {region.paletteNumber}
                      </text>
                    ))}
                  </svg>
                </article>

                <article className="card palette-panel">
                  <div className="paper-header">
                    <span>Palette Guide</span>
                    <small>Stable numbering carried into the PDF workbook</small>
                  </div>

                  <div className="palette-grid">
                    {pattern.palette.map((entry) => (
                      <div key={entry.index} className="palette-chip">
                        <span
                          className="palette-swatch"
                          style={{ backgroundColor: entry.hex }}
                        />
                        <strong>{entry.number}</strong>
                        <span>{entry.hex.toUpperCase()}</span>
                      </div>
                    ))}
                  </div>
                </article>
              </>
            ) : (
              <div className="card empty-state">
                <p>Select a photo, then generate the outline to see the preview.</p>
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}

export default App;
