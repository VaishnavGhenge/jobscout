export default function Loading() {
  return (
    <>
      <p className="micro">crunching the funnel</p>
      <h1>Insights</h1>
      <p className="subtitle">
        Which kinds of applications get answered — and which quietly don&apos;t.
      </p>
      <div className="funnel" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="fstat skeleton" key={i} style={{ height: 74 }} />
        ))}
      </div>
      <div
        className="headline skeleton"
        aria-hidden="true"
        style={{ height: 104 }}
      />
    </>
  );
}
