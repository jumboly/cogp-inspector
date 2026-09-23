import type { ReactNode } from 'react'

/** 「項目名: 値」の一覧。項目名には英語の識別子と日本語の意味を併記できるよう note を持たせる */
export function KV({ rows }: { rows: [label: ReactNode, value: ReactNode, note?: ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v, note], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>
            {v}
            {note && <div className="kv-note">{note}</div>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function RawJson({ text, summary = 'Raw JSON' }: { text: string; summary?: string }) {
  return (
    <details className="raw">
      <summary>{summary}</summary>
      <pre>{text}</pre>
    </details>
  )
}
