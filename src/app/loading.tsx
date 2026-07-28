export default function Loading() {
  return (
    <>
      <div className="rowbar">
        <div>
          <p className="micro">fetching live postings</p>
          <h1>Board</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Ranked by whether a role is worth an application, not by title match.
          </p>
        </div>
      </div>
      <div className="stats" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i}>
            <span className="skeleton line" style={{ width: 44, height: 22 }} />
            <span className="skeleton line sm" style={{ width: 70 }} />
          </span>
        ))}
      </div>
      <div className="jobs" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="job skeleton-row" key={i}>
            <div className="skeleton circle" />
            <div className="job-main">
              <div className="skeleton line lg" />
              <div className="skeleton line sm" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
