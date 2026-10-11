export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <p>{title}</p>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
