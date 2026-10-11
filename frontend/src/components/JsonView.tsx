/**
 * Pretty-prints JSON bodies; non-JSON payloads fall back to the raw text
 * under an explicit "raw text" label instead of showing nothing (04 §11).
 */
export function JsonView({ raw }: { raw: string }) {
  let rendered: string;
  let isFallback = false;
  try {
    rendered = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    rendered = raw;
    isFallback = true;
  }

  return (
    <div className="json-view">
      {isFallback ? (
        <p className="muted" data-testid="json-fallback-label">
          raw text
        </p>
      ) : null}
      <pre className="json-pre">{rendered}</pre>
    </div>
  );
}
