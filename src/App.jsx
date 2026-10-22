import { useCallback, useEffect, useMemo, useState } from 'react'
import { runQuery, inCond, notNull, dateRange } from './pbi.js'

const LOCATIONS = ['Gilman', 'Beacon Hill', 'Miller']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const weekStart = (d = new Date()) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s }
const fmtDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const p2 = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`

// Power BI sends dates as epoch ms (midnight, read in UTC) and times as "1899-12-30THH:mm:ss" strings.
const toDate = (v) => {
  if (v == null) return null
  const d = typeof v === 'number' ? new Date(v) : new Date(Date.parse(v))
  return Number.isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
const toMinutes = (v) => {
  if (v == null) return 0
  if (typeof v === 'number') { const d = new Date(v); return d.getUTCHours() * 60 + d.getUTCMinutes() }
  const m = /T(\d\d):(\d\d)/.exec(v)
  return m ? +m[1] * 60 + +m[2] : 0
}

// Same columns as the report's reservations table.
const COLUMNS = [
  ['o', 'Overlap_Name'], ['f1', 'URL'], ['f', 'RESERVATION_START_DATE'], ['f', 'RESERVATION_START_TIME'],
  ['f', 'RESERVATION_END_TIME'], ['f', 'Court Use', undefined, 'FACILITY_RESERVATION.Event'], ['f', 'StartEnd'], ['f', 'StartEndTime'],
]

// Turns raw rows into reservations (start set) and empty court markers (start null).
const toRows = (center, data) => data.map(([court, url, date, st, en, use, label, label2]) => {
  const day = toDate(date)
  const start = day ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, toMinutes(st)) : null
  return { center, court, url, use, start, label: label2 || label || null, rawDate: date }
})

// "8:45 AM - 10:00 AM" -> "8:45–10:00 AM"; "11:15 AM - 12:30 PM" -> "11:15 AM–12:30 PM"
const compact = (l) => {
  const m = /^\s*(\d+:\d+)(?::\d+)?\s*(AM|PM)\s*-\s*(\d+:\d+)(?::\d+)?\s*(AM|PM)\s*$/i.exec(l || '')
  if (!m) return l || ''
  return m[2].toUpperCase() === m[4].toUpperCase() ? `${m[1]}–${m[3]} ${m[4].toUpperCase()}` : `${m[1]} ${m[2].toUpperCase()}–${m[3]} ${m[4].toUpperCase()}`
}

export default function App() {
  const [state, setState] = useState({ status: 'loading', error: null })
  const [rows, setRows] = useState([])
  const [centers, setCenters] = useState([])
  const [attempts, setAttempts] = useState([])
  const start = useMemo(() => weekStart(), [])
  const end = useMemo(() => { const e = new Date(start); e.setDate(e.getDate() + 7); return e }, [start])

  const load = useCallback(async () => {
    setState({ status: 'loading', error: null })
    const log = []
    try {
      const all = await runQuery({ select: [['f1', 'CENTER_NAME'], ['f1', 'FACILITY_NAME']] })
      const found = [...new Set(all.map((r) => r[0]).filter((c) => c && LOCATIONS.some((l) => c.toLowerCase().includes(l.toLowerCase()))))]
      setCenters(found)
      log.push({ label: 'Centers matched', ok: true, count: found.length, extras: found.join(', ') || 'none', sample: [] })

      const result = []
      await Promise.all(found.map(async (center) => {
        const base = [inCond('f1', 'CENTER_NAME', [center]), notNull('f', 'RESERVATION_START_DATE')]
        const run = async (label, where) => {
          try {
            const got = toRows(center, await runQuery({ select: COLUMNS, where, showEmpty: true }))
            log.push({ label: `${center}: ${label}`, ok: true, count: got.filter((r) => r.start).length, extras: `${got.length} rows incl. empty courts`, sample: got.filter((r) => r.start).slice(0, 3) })
            return got
          } catch (e) { log.push({ label: `${center}: ${label}`, ok: false, error: e.message }); return [] }
        }
        // 1) every reservation this week (date range on the reservation table)
        let got = await run('this week (date range)', [...base, ...dateRange('f', 'RESERVATION_START_DATE', iso(start), iso(end))])
        // 2) fall back to the report's own query: "Today" slicer + dt_do
        if (!got.some((r) => r.start)) {
          const today = await run('Today slicer', [...base, inCond('a', 'DateForSlicer', ['Today']), notNull('a', 'dt_do'), notNull('a', 'DateForSlicer')])
          if (today.some((r) => r.start)) got = today
          else if (!got.length) got = today
        }
        result.push(...got)
      }))
      setRows(result)
      setAttempts(log)
      setState({ status: 'ready', error: null })
    } catch (e) {
      setAttempts(log)
      setState({ status: 'error', error: e.message })
    }
  }, [start, end])

  useEffect(() => { load() }, []) // eslint-disable-line

  const byLocation = useMemo(() => LOCATIONS.map((loc) => {
    const mineAll = rows.filter((r) => r.center.toLowerCase().includes(loc.toLowerCase()))
    const courts = [...new Set(mineAll.map((r) => r.court).filter(Boolean))].sort()
    const seen = new Set()
    const mine = mineAll.filter((r) => r.start && r.start >= start && r.start < end).filter((r) => {
      const k = `${r.court}|${+r.start}|${r.label}`
      if (seen.has(k)) return false
      seen.add(k); return true
    })
    const grid = courts.map((c) => ({
      name: c,
      days: DAYS.map((_, i) => mine.filter((r) => r.court === c && ((r.start.getDay() + 6) % 7) === i).sort((a, b) => a.start - b.start)),
    }))
    return { loc, total: mine.length, grid }
  }), [rows, start, end])

  const todayIdx = (new Date().getDay() + 6) % 7
  const weekEnd = new Date(end); weekEnd.setDate(weekEnd.getDate() - 1)

  return (
    <main>
      <header>
        <div>
          <h1>Court reservations</h1>
          <p className="sub">Week of {fmtDay(start)} – {fmtDay(weekEnd)} · Gilman, Beacon Hill, Miller</p>
        </div>
        <div className="controls">
          <button onClick={load} disabled={state.status === 'loading'}>Refresh</button>
        </div>
      </header>

      {state.status === 'loading' && <p className="note">Loading from Power BI…</p>}
      {state.status === 'error' && <div className="error"><b>Couldn’t load data.</b> {state.error}<br />If this is a network/CORS error, check the browser console.</div>}
      {state.status === 'ready' && !centers.length && (
        <div className="error">No centers matched “{LOCATIONS.join(', ')}”. The dataset’s names may differ; edit <code>LOCATIONS</code> in <code>src/App.jsx</code>.</div>
      )}

      {byLocation.map(({ loc, total, grid }) => (
        <section key={loc}>
          <h2>{loc} <span className="badge">{total} reservations</span></h2>
          {!grid.length ? <p className="note">No courts found.</p> : (
            <div className="scroll">
              <table>
                <thead><tr><th>Court</th>{DAYS.map((d, i) => {
                  const dt = new Date(start); dt.setDate(dt.getDate() + i)
                  return <th key={d} className={i === todayIdx ? 'today' : ''}>{d}<small>{fmtDay(dt)}</small></th>
                })}</tr></thead>
                <tbody>{grid.map((g) => (
                  <tr key={g.name}>
                    <th className="court">{g.name}</th>
                    {g.days.map((list, i) => (
                      <td key={i} className={i === todayIdx ? 'today' : ''}>
                        {list.length ? (
                          <ul>{list.map((r, j) => (
                            <li key={j}>{compact(r.label)}{r.use && r.use !== 'Other' ? <small> {r.use}</small> : null}</li>
                          ))}</ul>
                        ) : <span className="zero">–</span>}
                      </td>
                    ))}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <details className="diag">
        <summary>Diagnostics</summary>
        <p>Reservations loaded: {rows.filter((r) => r.start).length} · this week: {byLocation.reduce((n, l) => n + l.total, 0)}</p>
        {attempts.map((a, i) => (
          <div key={i} className="attempt">
            <b>{a.label}</b>: {a.ok ? `${a.count} (${a.extras})` : <span className="bad">failed – {a.error}</span>}
            {a.sample?.map((r, j) => <div key={j} className="mono">{r.court} · {r.label} · raw date {String(r.rawDate)} → {r.start?.toString().slice(0, 21)}</div>)}
          </div>
        ))}
      </details>
    </main>
  )
}
