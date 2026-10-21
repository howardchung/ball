// Minimal client for the public Power BI "querydata" endpoint used by the report.
const ENDPOINT = '/pbi/public/reports/querydata?synchronous=true'
const RESOURCE_KEY = '8d368efd-fa3a-4072-aece-90acdcf1bd23'
const ENTITIES = { f: 'FACILITY_RESERVATION', a: 'ACTIVE_HUB_DATES', f1: 'FACILITIES' }

const col = (s, p) => ({ Column: { Expression: { SourceRef: { Source: s } }, Property: p } })
const lit = (v) => ({ Literal: { Value: `'${String(v).replace(/'/g, "''")}'` } })
export const inCond = (s, p, vals) => ({
  Condition: { In: { Expressions: [col(s, p)], Values: vals.map((v) => [lit(v)]) } },
})
export const notNull = (s, p) => ({
  Condition: { Not: { Expression: { Comparison: { ComparisonKind: 0, Left: col(s, p), Right: { Literal: { Value: 'null' } } } } } },
})

// select: [[alias, property], ...]; where: condition objects
export async function runQuery({ select, where = [] }) {
  const aliases = [...new Set([...select.map((s) => s[0]), ...where.map(whereAliases).flat()])]
  const body = {
    version: '1.0.0',
    queries: [{
      Query: { Commands: [{ SemanticQueryDataShapeCommand: {
        Query: {
          Version: 2,
          From: aliases.map((a) => ({ Name: a, Entity: ENTITIES[a], Type: 0 })),
          Select: select.map(([a, p]) => ({ ...col(a, p), Name: `${ENTITIES[a]}.${p}` })),
          Where: where,
        },
        Binding: {
          Primary: { Groupings: [{ Projections: select.map((_, i) => i) }] },
          DataReduction: { DataVolume: 4, Primary: { Window: { Count: 30000 } } },
          Version: 1,
        },
        ExecutionMetricsKind: 1,
      } }] },
      QueryId: '',
      ApplicationContext: {
        DatasetId: '53b5ae66-86f3-4c9a-8eff-8a382060fa34',
        Sources: [{ ReportId: 'e9dabde7-8778-46fb-910b-5f66862f9be6', VisualId: '1934311a369767efc8c2' }],
      },
    }],
    cancelQueries: [],
    modelId: 869389,
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      ActivityId: crypto.randomUUID(),
      RequestId: crypto.randomUUID(),
      'X-PowerBI-ResourceKey': RESOURCE_KEY,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Power BI returned HTTP ${res.status}`)
  const json = await res.json()
  const r = json.results?.[0]?.result
  if (!r || r.error || json.error) throw new Error(JSON.stringify(r?.error || json.error || json).slice(0, 400))
  return decode(r.data)
}

const whereAliases = (c) => [...JSON.stringify(c).matchAll(/"Source":"(\w+)"/g)].map((m) => m[1])

// Decode Power BI's compressed "DSR" row format into plain arrays.
function decode(data) {
  const ds = data?.dsr?.DS?.[0]
  const rows = ds?.PH?.[0]?.DM0
  if (!rows) return []
  const dicts = ds.ValueDicts || {}
  let schema = null, prev = []
  const out = []
  for (const row of rows) {
    if (row.S) schema = row.S
    const R = row.R || 0, N = row['Ø'] || 0
    const cur = []
    let ci = 0
    for (let i = 0; i < schema.length; i++) {
      const bit = 1 << i
      if (R & bit) cur[i] = prev[i]
      else if (N & bit) cur[i] = null
      else {
        let v = row.C[ci++]
        if (schema[i].DN) v = dicts[schema[i].DN][v]
        cur[i] = v
      }
    }
    out.push(cur)
    prev = cur
  }
  return out
}
