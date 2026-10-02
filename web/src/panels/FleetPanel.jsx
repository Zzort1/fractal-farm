/**
 * The container fleet, as the cloud sees it: one dot per task the service
 * wants — solid when running, pulsing while it starts — and the scaling
 * controller's reasoning for the current count.
 */

/**
 * @param {{label: string, counts: Object|null, colour: string}} props - One service's counts
 * @returns {JSX.Element} Dots
 */
function TaskDots({ label, counts, colour }) {
  if (!counts) return null;
  const slots = Math.max(counts.desired, counts.running + counts.pending);
  return (
    <div className="task-row">
      <span className="task-label">{label}</span>
      <span className="task-dots" style={{ "--dot": colour }}>
        {Array.from({ length: slots }, (_, i) => (
          <i
            key={i}
            className={i < counts.running ? "running" : i < counts.running + counts.pending ? "pending" : "wanted"}
          />
        ))}
        {slots === 0 && <em>scaled to zero</em>}
      </span>
      <span className="task-count">
        {counts.running}/{counts.desired}
      </span>
    </div>
  );
}

const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/**
 * @param {{fleet: Object}} props - Fleet snapshot from the API
 * @returns {JSX.Element} Panel section
 */
export default function FleetPanel({ fleet }) {
  const scaler = fleet.scaler;

  return (
    <section>
      <h3>
        Fargate fleet <small>live from ECS</small>
      </h3>
      <TaskDots label="workers" counts={fleet.workers} colour="var(--magenta)" />
      <TaskDots label="api" counts={fleet.api} colour="var(--cyan)" />

      <h3>
        Scaler <small>{scaler ? ago(scaler.at) : "no status yet"}</small>
      </h3>
      {scaler && (
        <>
          <p className="scaler-reason">{scaler.reason}</p>
          <p className="hint">
            target {scaler.policy.targetPerWorker} jobs/worker · {scaler.policy.min}–{scaler.policy.max} workers ·{" "}
            {Math.round(scaler.policy.scaleInCooldownMs / 1000)}s cool-down
          </p>
          {scaler.history.length > 0 && (
            <ol className="scale-history">
              {scaler.history.slice(0, 5).map((event) => (
                <li key={event.at}>
                  <b className={event.to > event.from ? "up" : "down"}>
                    {event.from}→{event.to}
                  </b>
                  <span>{event.reason}</span>
                  <small>{ago(event.at)}</small>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
