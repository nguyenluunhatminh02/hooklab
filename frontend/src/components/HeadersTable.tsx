/**
 * Captured request headers (02 §5.1). The server stores only the whitelist —
 * cookies/authorization are dropped at capture — so this renders exactly what
 * the wire sent, no client-side filtering.
 */
export function HeadersTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return <p className="muted">No captured headers.</p>;
  }
  return (
    <table className="headers-table">
      <caption className="visually-hidden">Captured request headers</caption>
      <tbody>
        {entries.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
