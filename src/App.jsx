import { useCallback, useEffect, useMemo, useState } from 'react'
import { runQuery, inCond, notNull } from './pbi.js'

const LOCATIONS = ['Gilman', 'Beacon Hill', 'Miller']
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Power BI returns datetimes as epoch ms of the *local* wall-clock time, so read UTC parts.
const naive = (ms) => { const d = new Date(ms); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()) }
const weekStart = (d = new Date()) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return s }
const fmtDay = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export default function App() {
  const [state, setState] = useState({ status: 'loading', error: null })
  const [rows, setRows] = useState([])
  const [facilities, setFacilities] = useState([])
  const [slicers, setSlicers] = useState([])
  const [slicer, setSlicer] = useState(null) // null = no server-side date filter
  const [open, setOpen] = useState(null)
  const start = useMemo(() => weekStart(), [])
  const end = useMemo(() => { const e = new Date(start); e.setDate(e.getDate() + 7); return e }, [start])

  const load = useCallback(async (chosenSlicer, firstLoad) => {
    setState({ status: 'loading', error: null })
    try {
      let fac = facilities, sl = chosenSlicer
      if (firstLoad) {
        const [dates, all] = await Promise.all([
          runQuery({ select: [['a', 'DateForSlicer']] }),
          runQuery({ select: [['f1', 'CENTER_NAME'], ['f1', 'FACILITY_NAME']] }),
        ])
        const vals = dates.map((r) => r[0]).filter(Boolean)
        setSlicers(vals)
        const wk = vals.find((v) => /week/i.test(v) && !/last|prev|next/i.test(v))
        sl = wk ?? null
        setSlicer(sl)
        fac = all
          .map(([center, name]) => ({ center, name }))
          .filter((f) => LOCATIONS.some((l) => `${f.center} ${f.name}`.toLowerCase().includes(l.toLowerCase())))
        setFacilities(fac)
      }
      if (!fac.length) { setRows([]); setState({ status: 'ready', error: null }); return }
      const where = [inCond('f1', 'FACILITY_NAME', fac.map((f) => f.name)), notNull('f', 'RESERVATION_START_DATE')]
      if (sl) where.push(inCond('a', 'DateForSlicer', [sl]))
      const base = [['f1', 'CENTER_NAME'], ['f1', 'FACILITY_NAME'], ['f', 'RESERVATION_START_DATE']]
      let data
      try { data = await runQuery({ select: [...base, ['f', 'RESERVATION_END_DATE']], where }) }
      catch { data = (await runQuery({ select: base, where })).map((r) => [...r, null]) }
      setRows(data.map(([center, name, s, e]) => ({ center, name, start: naive(s), end: e ? naive(e) : null })))
      setState({ status: 'ready', error: null })
    } catch (e) {
      setState({ status: 'error', error: e.message })
    }
  }, [facilities])

  useEffect(() => { load(null, true) }, []) // eslint-disable-line

  const byLocation = useMemo(() => LOCATIONS.map((loc) => {
    const facs = facilities.filter((f) => `${f.center} ${f.name}`.toLowerCase().includes(loc.toLowerCase()))
    const names = [...new Set(facs.map((f) => f.name))].sort()
    const mine = rows.filter((r) => names.includes(r.name) && r.start >= start && r.start < end)
    const grid = names.map((n) => ({
      name: n,
      days: DAYS.map((_, i) => mine.filter((r) => r.name === n && ((r.start.getDay() + 6) % 7) === i).sort((a, b) => a.start - b.start)),
    }))
    return { loc, total: mine.length, grid }
  }), [rows, facilities, start, end])

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
          <label>Report date filter
            <select value={slicer ?? ''} onChange={(e) => { const v = e.target.value || null; setSlicer(v); load(v, false) }}>
              <option value="">None (filter in app)</option>
              {slicers.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <button onClick={() => load(slicer, false)} disabled={state.status === 'loading'}>Refresh</button>
        </div>
      </header>

      {state.status === 'loading' && <p className="note">Loading from Power BI…</p>}
      {state.status === 'error' && <div className="error"><b>Couldn’t load data.</b> {state.error}<br />If this is a network/CORS error, check the browser console.</div>}
      {state.status === 'ready' && !facilities.length && (
        <div className="error">No facilities matched “{LOCATIONS.join(', ')}”. The dataset’s names may differ; edit <code>LOCATIONS</code> in <code>src/App.jsx</code>.</div>
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
                          {open === key && <ul>{list.map((r, j) => <li key={j}>{fmtTime(r.start)}{r.end ? `–${fmtTime(r.end)}` : ''}</li>)}</ul>}
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
    </main>
  )
}
