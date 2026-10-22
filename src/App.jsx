import { useCallback, useEffect, useMemo, useState } from 'react'
import { runQuery, inCond, notNull, dateRange } from './pbi.js'

const LOCATIONS = ['Gilman', 'Beacon Hill', 'Miller']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Power BI returns datetimes as epoch ms of the *local* wall-clock time, so read UTC parts.
const naive = (ms) => { const d = new Date(ms); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()) }
const weekStart = (d = new Date()) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s }
const fmtDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const p2 = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`

// Optional extra columns, tried from most to least informative until the model accepts one.
const END = ['f', 'RESERVATION_END_DATE']
const DISPLAY = ['f', 'DateToDisplay', 'm'] // the measure the report itself shows
const VARIANTS = [[END, DISPLAY], [DISPLAY], [END], []]

export default function App() {
  const [state, setState] = useState({ status: 'loading', error: null })
  const [rows, setRows] = useState([])
  const [facilities, setFacilities] = useState([])
  const [attempts, setAttempts] = useState([])
  const [open, setOpen] = useState(null)
  const start = useMemo(() => weekStart(), [])
  const end = useMemo(() => { const e = new Date(start); e.setDate(e.getDate() + 7); return e }, [start])

  const load = useCallback(async () => {
    setState({ status: 'loading', error: null })
    const log = []
    try {
      const all = await runQuery({ select: [['f1', 'CENTER_NAME'], ['f1', 'FACILITY_NAME']] })
      const fac = all
        .map(([center, name]) => ({ center, name }))
        .filter((f) => LOCATIONS.some((l) => `${f.center} ${f.name}`.toLowerCase().includes(l.toLowerCase())))
      setFacilities(fac)
      if (!fac.length) { setRows([]); setAttempts(log); setState({ status: 'ready', error: null }); return }

      const names = fac.map((f) => f.name)
      const base = [['f1', 'CENTER_NAME'], ['f1', 'FACILITY_NAME'], ['f', 'RESERVATION_START_DATE']]

      // Runs one strategy, records it for the diagnostics panel, returns its rows.
      const attempt = async (label, extraWhere) => {
        const where = [inCond('f1', 'FACILITY_NAME', names), notNull('f', 'RESERVATION_START_DATE'), ...extraWhere]
        let lastErr
        for (const extra of VARIANTS) {
          try {
            const data = await runQuery({ select: [...base, ...extra], where })
            const got = data.map((r) => {
              const o = { center: r[0], name: r[1], rawStart: r[2], start: naive(r[2]), end: null, label: null }
              extra.forEach((c, i) => { if (c === END) o.end = r[3 + i] ? naive(r[3 + i]) : null; if (c === DISPLAY) o.label = r[3 + i] })
              return o
            })
            log.push({ label, ok: true, count: got.length, extras: extra.map((c) => c[1]).join(', ') || 'none', sample: got.slice(0, 3) })
            return got
          } catch (e) { lastErr = e }
        }
        log.push({ label, ok: false, error: lastErr.message })
        return []
      }

      // 1) Server-side filter on this week's date range: keeps the result small (Power BI caps responses at 30k rows).
      let result = await attempt('Date range filter (this week)', dateRange('f', 'RESERVATION_START_DATE', iso(start), iso(end)))

      // 2) Fall back to the report's own date slicer + dt_do filter, as the original report query does.
      if (!result.length) {
        let slicerValues = []
        try { slicerValues = (await runQuery({ select: [['a', 'DateForSlicer']] })).map((r) => r[0]).filter(Boolean) } catch (e) { log.push({ label: 'Load slicer values', ok: false, error: e.message }) }
        const picks = slicerValues.filter((v) => /today|week|tomorrow|day/i.test(v) && !/last|prev|yesterday/i.test(v)).slice(0, 4)
        log.push({ label: 'Slicer values found', ok: true, count: slicerValues.length, extras: slicerValues.slice(0, 12).join(' | '), sample: [] })
        const seen = new Set()
        for (const v of picks) {
          const got = await attempt(`Report slicer “${v}”`, [inCond('a', 'DateForSlicer', [v]), notNull('a', 'dt_do')])
          for (const r of got) { const k = `${r.name}|${r.rawStart}|${r.end}`; if (!seen.has(k)) { seen.add(k); result.push(r) } }
        }
      }
      setRows(result)
      setAttempts(log)
      setState({ status: 'ready', error: null })
    } catch (e) {
      setAttempts(log)
      setState({ status: 'error', error: e.message })
    }
  }, [start, end])

  useEffect(() => { load() }, []) // eslint-disable-line

  const inWeek = useMemo(() => rows.filter((r) => r.start >= start && r.start < end), [rows, start, end])

  const byLocation = useMemo(() => LOCATIONS.map((loc) => {
    const facs = facilities.filter((f) => `${f.center} ${f.name}`.toLowerCase().includes(loc.toLowerCase()))
    const names = [...new Set(facs.map((f) => f.name))].sort()
    const mine = inWeek.filter((r) => names.includes(r.name))
    const grid = names.map((n) => ({
      name: n,
      days: DAYS.map((_, i) => mine.filter((r) => r.name === n && ((r.start.getDay() + 6) % 7) === i).sort((a, b) => a.start - b.start)),
    }))
    return { loc, total: mine.length, grid }
  }), [inWeek, facilities])

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
      {state.status === 'ready' && !facilities.length && (
        <div className="error">No facilities matched “{LOCATIONS.join(', ')}”. The dataset’s names may differ; edit <code>LOCATIONS</code> in <code>src/App.jsx</code>.</div>
      )}
      {state.status === 'ready' && facilities.length > 0 && rows.length > 0 && !inWeek.length && (
        <div className="error">Loaded {rows.length} reservations, but none start this week. See diagnostics below.</div>
      )}

      {byLocation.map(({ loc, total, grid }) => (
        <section key={loc}>
          <h2>{loc} <span className="badge">{total} reservations</span></h2>
          {!grid.length ? <p className="note">No matching facilities.</p> : (
            <div className="scroll">
              <table>
                <thead><tr><th>Court</th>{DAYS.map((d, i) => {
                  const dt = new Date(start); dt.setDate(dt.getDate() + i)
                  return <th key={d} className={i === todayIdx ? 'today' : ''}>{d}<small>{fmtDay(dt)}</small></th>
                })}</tr></thead>
                <tbody>{grid.map((g) => (
                  <tr key={g.name}>
                    <th className="court">{g.name}</th>
                    {g.days.map((list, i) => {
                      const key = `${g.name}-${i}`
                      return (
                        <td key={i} className={i === todayIdx ? 'today' : ''}>
                          {list.length ? <button className="cell" onClick={() => setOpen(open === key ? null : key)}>{list.length}</button> : <span className="zero">–</span>}
                          {open === key && <ul>{list.map((r, j) => <li key={j}>{r.label || `${fmtTime(r.start)}${r.end ? `–${fmtTime(r.end)}` : ''}`}</li>)}</ul>}
                        </td>
                      )
                    })}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      ))}

      <details className="diag">
        <summary>Diagnostics</summary>
        <p>Matched facilities: {facilities.length} · reservations loaded: {rows.length} · this week: {inWeek.length}</p>
        {attempts.map((a, i) => (
          <div key={i} className="attempt">
            <b>{a.label}</b>: {a.ok ? `${a.count} ${/Slicer values/.test(a.label) ? 'values' : 'rows'} (extra columns: ${a.extras})` : <span className="bad">failed – {a.error}</span>}
            {a.sample?.map((r, j) => <div key={j} className="mono">{r.name} · raw {String(r.rawStart)} → {r.start.toString().slice(0, 21)}{r.label ? ` · “${r.label}”` : ''}</div>)}
          </div>
        ))}
      </details>
    </main>
  )
}
