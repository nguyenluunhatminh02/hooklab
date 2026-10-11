/**
 * Timeline search box. The caller debounces `onChange` with
 * `useDebouncedValue(SEARCH_DEBOUNCE_MS)` — this component stays a plain
 * controlled input so typing never waits on the network.
 *
 * `modes` lists what the server-side `q` actually matches on that route
 * (02 §5): subscriber lists match event type + exact request id; the
 * workspace route additionally matches token prefix. The placeholder must
 * not advertise modes a route cannot serve.
 */
export function SearchInput({
  value,
  onChange,
  label = 'Search records',
  modes = 'event type, request id',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  modes?: string;
}) {
  return (
    <label className="timeline-search">
      <span className="visually-hidden">{label}</span>
      <input
        type="search"
        placeholder={`${label} (${modes})`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
