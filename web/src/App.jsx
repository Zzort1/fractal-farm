/**
 * Fractal Farm — the browser client.
 *
 * Holds what the user has chosen (fractal, parameters, colours, overlays) and
 * hands it to the viewer. Parameters are canonicalised with the same core code
 * the API uses, so the browser always requests the canonical tile URL and
 * never pays for a redirect.
 *
 * Two views share one fractal viewer: "Explorer" shows it full size;
 * "Under the hood" shrinks it into a corner window and fills the stage with
 * the live architecture map, while the left panel becomes the AWS call log.
 * The viewer stays mounted throughout, so the view and loaded tiles survive.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canonicalParams, defaultParams, getFractal, listFractals } from "@fractal-farm/core";
import ControlPanel from "./panels/ControlPanel.jsx";
import ControlRoom from "./panels/ControlRoom.jsx";
import { useStats } from "./panels/useStats.js";
import CallLog from "./hood/CallLog.jsx";
import HoodMap from "./hood/HoodMap.jsx";
import HoodMetrics from "./hood/HoodMetrics.jsx";
import { useTrace } from "./hood/useTrace.js";
import FractalCanvas from "./viewer/FractalCanvas.jsx";

/** ?view=hood opens straight into the hood; otherwise the tab open last. */
function storedTab() {
  const requested = new URLSearchParams(location.search).get("view");
  if (requested === "hood" || requested === "explorer") return requested;
  try {
    return localStorage.getItem("ff-tab") === "hood" ? "hood" : "explorer";
  } catch {
    return "explorer";
  }
}

const initialParams = Object.fromEntries(listFractals().map((f) => [f.id, defaultParams(f.id)]));

/**
 * Enough digits to tell neighbouring pixels apart at the current zoom.
 * @param {number} value - Coordinate
 * @param {number} pixelSize - Plane units per pixel
 * @returns {string} Formatted coordinate
 */
function formatCoordinate(value, pixelSize) {
  const digits = Math.min(17, Math.max(4, Math.ceil(-Math.log10(pixelSize)) + 1));
  return value.toFixed(digits);
}

export default function App() {
  const [fractalId, setFractalId] = useState("mandelbrot");
  const [rawParams, setRawParams] = useState(initialParams);
  const [colour, setColour] = useState({
    paletteId: "nebula",
    density: 0.35,
    offset: 0,
    cycle: false,
    cycleSpeed: 0.08,
  });
  const [overlays, setOverlays] = useState({ workers: false, sources: true });
  const [view, setView] = useState(null);
  const [resetToken, setResetToken] = useState(0);
  const [clearToken, setClearToken] = useState(0);
  const lastValid = useRef({});
  const [tab, setTab] = useState(storedTab);
  const [mini, setMini] = useState("normal"); // normal | large | collapsed
  const [speed, setSpeed] = useState(1);
  const [showControl, setShowControl] = useState(false);
  const { stats, connected } = useStats();
  const bus = useTrace(tab === "hood");

  useEffect(() => {
    try {
      localStorage.setItem("ff-tab", tab);
    } catch {
      // Storage unavailable: the tab simply is not remembered.
    }
  }, [tab]);

  const fractal = getFractal(fractalId);

  const canonical = useMemo(() => {
    try {
      const result = canonicalParams(fractalId, rawParams[fractalId]);
      lastValid.current[fractalId] = result;
      return { ...result, error: null };
    } catch (error) {
      // Keep showing the last good tiles while the input is being fixed.
      return { ...(lastValid.current[fractalId] ?? canonicalParams(fractalId, {})), error: error.message };
    }
  }, [fractalId, rawParams]);

  const setParam = useCallback(
    (key, value) => setRawParams((all) => ({ ...all, [fractalId]: { ...all[fractalId], [key]: value } })),
    [fractalId],
  );

  const applyPreset = useCallback(
    ({ name, ...values }) => setRawParams((all) => ({ ...all, [fractalId]: { ...all[fractalId], ...values } })),
    [fractalId],
  );

  /** Shift-click on the Mandelbrot opens the Julia set of the clicked point. */
  const pickJulia = useCallback(
    ({ re, im }) => {
      if (fractalId !== "mandelbrot") return;
      setRawParams((all) => ({
        ...all,
        julia: { ...all.julia, cre: Number(re.toFixed(4)), cim: Number(im.toFixed(4)) },
      }));
      setFractalId("julia");
    },
    [fractalId],
  );

  const pixelSize = view ? fractal.home.span / (256 * 2 ** view.zoom) : 1;
  const magnification = view ? 2 ** (view.level || 0) : 1;

  return (
    <div className={`app tab-${tab}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <div>
            <h1>Fractal Farm</h1>
            <p>a distributed, cached, auto-scaling fractal render farm</p>
          </div>
        </div>
        <nav className="tabs" aria-label="View">
          <button type="button" className={`tab${tab === "explorer" ? " active" : ""}`} onClick={() => setTab("explorer")}>
            Explorer
          </button>
          <button type="button" className={`tab tab-hood${tab === "hood" ? " active" : ""}`} onClick={() => setTab("hood")}>
            Under the hood
          </button>
        </nav>
        <div className="topbar-meta">
          <span className="pill">CAB432 · Assessment 3</span>
          <span className="pill pill-glow">{fractal.name}</span>
        </div>
      </header>

      {tab === "hood" ? (
        <CallLog bus={bus} />
      ) : (
      <ControlPanel
        fractalId={fractalId}
        onFractal={setFractalId}
        params={canonical.params}
        onParam={setParam}
        paramError={canonical.error}
        onPreset={applyPreset}
        colour={colour}
        onColour={(patch) => setColour((c) => ({ ...c, ...patch }))}
        overlays={overlays}
        onOverlays={(patch) => setOverlays((o) => ({ ...o, ...patch }))}
        onReset={() => setResetToken((t) => t + 1)}
      />
      )}

      <main className="stage">
        {tab === "hood" && (
          <div className="hood">
            <HoodMetrics
              bus={bus}
              fleet={stats?.fleet ?? null}
              stats={stats}
              platform={stats?.platform}
              speed={speed}
              onSpeed={setSpeed}
              showControl={showControl}
              onShowControl={setShowControl}
            />
            <div className="hood-map">
              <HoodMap
                bus={bus}
                fleet={stats?.fleet ?? null}
                stats={stats}
                platform={stats?.platform}
                held={view?.held ?? 0}
                speed={speed}
                showControl={showControl}
              />
            </div>
          </div>
        )}
        <div className={`viewer-wrap${tab === "hood" ? ` mini mini-${mini}` : ""}`}>
          {tab === "hood" && (
            <div className="mini-bar">
              <span>
                {fractal.name} · level {view?.level ?? 0}
              </span>
              <span className="mini-buttons">
                <button type="button" onClick={() => setMini(mini === "large" ? "normal" : "large")} aria-label="Resize">
                  {mini === "large" ? "▭" : "▣"}
                </button>
                <button type="button" onClick={() => setMini(mini === "collapsed" ? "normal" : "collapsed")} aria-label="Minimise">
                  {mini === "collapsed" ? "▴" : "▾"}
                </button>
              </span>
            </div>
          )}
          <FractalCanvas
          fractalId={fractalId}
          query={canonical.query}
          params={canonical.params}
          colour={colour}
          overlays={overlays}
          resetToken={resetToken}
          clearToken={clearToken}
          onViewChange={setView}
          onPick={pickJulia}
          />
        </div>
        {tab === "explorer" && (
          <div className="stage-help">drag to pan · scroll to zoom · double-click to dive · alt+double-click to rise</div>
        )}
      </main>

      <ControlRoom
        stats={stats}
        connected={connected}
        onFlushed={() => setClearToken((t) => t + 1)}
        held={view?.held ?? 0}
      />

      <footer className="statusbar">
        {view && (
          <>
            <span>
              centre <b>{formatCoordinate(view.cx, pixelSize)}</b> {view.cy < 0 ? "−" : "+"}{" "}
              <b>{formatCoordinate(Math.abs(view.cy), pixelSize)}</b>i
            </span>
            <span>
              level <b>{view.level}</b> / {fractal.maxZoom}
            </span>
            <span>
              magnification <b>×{magnification >= 1e6 ? magnification.toExponential(2) : magnification.toLocaleString()}</b>
            </span>
            <span>
              tiles <b>{view.tiles}</b> · loading <b>{view.loading}</b>
            </span>
            {view.cursor && (
              <span className="cursor-readout">
                cursor <b>{formatCoordinate(view.cursor.re, pixelSize)}</b>{" "}
                {view.cursor.im < 0 ? "−" : "+"} <b>{formatCoordinate(Math.abs(view.cursor.im), pixelSize)}</b>i
              </span>
            )}
          </>
        )}
      </footer>
    </div>
  );
}
