/**
 * Left panel: choose a fractal, set the parameters that define its tiles,
 * and set the colours that never leave the browser.
 *
 * The split is visible on purpose: the "Shape" section changes tile URLs (new
 * renders, new cache entries); the "Colour" section changes nothing in the cloud.
 */
import { useEffect, useState } from "react";
import { listFractals } from "@fractal-farm/core";
import { PALETTES, paletteCss } from "../viewer/palettes.js";

const FRACTALS = listFractals();

/**
 * A numeric parameter that only commits when the user lets go, so dragging a
 * slider does not request a fresh set of tiles at every intermediate value.
 */
function NumberParam({ def, value, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => onCommit(def.key, draft);

  return (
    <div className="number-param">
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={Number.isFinite(Number(draft)) ? draft : value}
        onChange={(event) => setDraft(event.target.value)}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <input
        type="text"
        inputMode="decimal"
        className="number-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
      />
    </div>
  );
}

/**
 * @param {Object} props - See App
 * @returns {JSX.Element} Panel
 */
export default function ControlPanel({
  fractalId,
  onFractal,
  params,
  onParam,
  paramError,
  onPreset,
  colour,
  onColour,
  overlays,
  onOverlays,
  onReset,
}) {
  const fractal = FRACTALS.find((f) => f.id === fractalId);

  return (
    <aside className="panel panel-left">
      <section>
        <h2>
          <span className="dot dot-magenta" />
          Fractal
        </h2>
        <div className="fractal-grid">
          {FRACTALS.map((f, i) => (
            <button
              key={f.id}
              type="button"
              className={`fractal-card hue-${i % 7}${f.id === fractalId ? " active" : ""}`}
              onClick={() => onFractal(f.id)}
              title={f.blurb}
            >
              {f.name}
            </button>
          ))}
        </div>
        <p className="blurb">{fractal.blurb}</p>
      </section>

      <section>
        <h2>
          <span className="dot dot-cyan" />
          Shape <small>new tiles · rendered in the cloud</small>
        </h2>
        {fractal.params.map((def) => (
          <label key={def.key} className="field">
            <span>{def.label}</span>
            {def.type === "select" ? (
              <div className="chips">
                {def.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`chip${String(params[def.key]) === String(option) ? " active" : ""}`}
                    onClick={() => onParam(def.key, option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : (
              <NumberParam def={def} value={params[def.key]} onCommit={onParam} />
            )}
          </label>
        ))}
        {fractal.presets && (
          <div className="field">
            <span>Presets</span>
            <div className="chips">
              {fractal.presets.map((preset) => (
                <button key={preset.name} type="button" className="chip" onClick={() => onPreset(preset)}>
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {paramError && <p className="error">{paramError}</p>}
        {fractalId === "mandelbrot" && (
          <p className="hint">Shift-click anywhere to open the Julia set for that point.</p>
        )}
      </section>

      <section>
        <h2>
          <span className="dot dot-lime" />
          Colour <small>browser only · free</small>
        </h2>
        <div className="palette-grid">
          {PALETTES.map((palette) => (
            <button
              key={palette.id}
              type="button"
              className={`palette${palette.id === colour.paletteId ? " active" : ""}`}
              style={{ backgroundImage: paletteCss(palette) }}
              onClick={() => onColour({ paletteId: palette.id })}
              title={palette.name}
              aria-label={palette.name}
            />
          ))}
        </div>
        <label className="field">
          <span>
            Band density <b>{colour.density.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min="0.02"
            max="2"
            step="0.01"
            value={colour.density}
            onChange={(event) => onColour({ density: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          <span>
            Colour offset <b>{colour.offset.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={colour.offset}
            onChange={(event) => onColour({ offset: Number(event.target.value) })}
          />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={colour.cycle} onChange={(event) => onColour({ cycle: event.target.checked })} />
          <span>Cycle colours</span>
          <input
            type="range"
            min="0.02"
            max="0.6"
            step="0.01"
            value={colour.cycleSpeed}
            disabled={!colour.cycle}
            onChange={(event) => onColour({ cycleSpeed: Number(event.target.value) })}
          />
        </label>
      </section>

      <section>
        <h2>
          <span className="dot dot-gold" />
          Show the cloud
        </h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={overlays.workers}
            onChange={(event) => onOverlays({ workers: event.target.checked })}
          />
          <span>Tint tiles by worker</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={overlays.sources}
            onChange={(event) => onOverlays({ sources: event.target.checked })}
          />
          <span>Flash cache source</span>
        </label>
        <button type="button" className="button button-ghost" onClick={onReset}>
          Reset view
        </button>
      </section>
    </aside>
  );
}
