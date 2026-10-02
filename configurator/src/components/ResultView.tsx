import type { ReactNode } from "react";

/** Orders keys as declared in the schema, then any extra keys. */
function orderedKeys(keys: string[], schema: any): string[] {
  const declared = Object.keys(schema?.properties ?? {});
  return [...declared.filter((k) => keys.includes(k)), ...keys.filter((k) => !declared.includes(k))];
}

function formatCell(value: unknown): string {
  if (typeof value === "number" && !Number.isInteger(value)) return String(Number(value.toFixed(4)));
  return value === null || value === undefined ? "—" : String(value);
}

/** Renders a structured job result: strings as text, arrays of flat objects as tables, in schema order. */
export function ResultView({ value, schema, depth = 0 }: { value: unknown; schema?: any; depth?: number }): ReactNode {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;
  if (typeof value !== "object") return <p className="whitespace-pre-wrap">{String(value)}</p>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">(empty)</span>;
    const flat = value.every(
      (v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== "object"),
    );
    if (flat) {
      const columns = orderedKeys([...new Set(value.flatMap((v) => Object.keys(v as object)))], schema?.items);
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} className="table-cell font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c} className="table-cell">
                      {formatCell((row as Record<string, unknown>)[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <ul className="list-disc space-y-1 pl-5">
        {value.map((v, i) => (
          <li key={i}>{typeof v === "object" ? <ResultView value={v} schema={schema?.items} depth={depth + 1} /> : String(v)}</li>
        ))}
      </ul>
    );
  }
  if (depth > 3) return <pre className="input-mono">{JSON.stringify(value, null, 2)}</pre>;
  const record = value as Record<string, unknown>;
  return (
    <div className="space-y-3">
      {orderedKeys(Object.keys(record), schema).map((key) => (
        <div key={key}>
          <div className="label">{key}</div>
          <ResultView value={record[key]} schema={schema?.properties?.[key]} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}
