export default function Loading() {
  return (
    <>
      <p className="micro">loading pipeline</p>
      <h1>Tracker</h1>
      <p className="subtitle">
        Your pipeline, and how long each side has been waiting on the other.
      </p>
      <div className="board" aria-hidden="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div className="col" key={i}>
            <div className="skeleton line sm" style={{ width: "60%" }} />
            <div className="card skeleton" style={{ height: 92 }} />
            <div className="card skeleton" style={{ height: 92 }} />
          </div>
        ))}
      </div>
    </>
  );
}
