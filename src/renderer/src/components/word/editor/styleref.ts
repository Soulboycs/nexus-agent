/**
 * STYLEREF field resolution (headers/footers): Word shows the text of the
 * closest paragraph carrying the referenced style — any style, not just
 * headings. Style names match case/space-insensitively with "heading N" /
 * "标题 N" treated as aliases of each other. Search order per Word: first
 * occurrence on the current page, else the closest one before the page, else
 * the first one after it; an unresolvable style renders blank rather than an
 * error string.
 */
export interface StylerefEntry {
  /** resolved style display name (e.g. 'heading 1', '标题 1', 'Title', custom) */
  styleName: string
  text: string
  /** 1-based page the paragraph starts on; unknown while unmeasured */
  page?: number
}

/** canonical comparison key: 'Heading 1'/'heading1'/'标题 1'/'标题1' -> 'h1'; others lowercased */
export function normalizeStyleName(name: string): string {
  const lower = name.trim().toLowerCase().replace(/\s+/g, ' ')
  const alias = /^(?:heading|标题)\s*(\d)$/.exec(lower)
  return alias ? `h${alias[1]}` : lower
}

export function stylerefText(
  entries: StylerefEntry[],
  query: string,
  pageNo: number,
): string {
  const want = normalizeStyleName(query)
  if (!want) return ''
  const of = entries.filter(
    (e) => normalizeStyleName(e.styleName) === want && e.text.trim(),
  )
  const onPage = of.find((e) => e.page === pageNo)
  if (onPage) return onPage.text.trim()
  let before: StylerefEntry | undefined
  for (const e of of) if (e.page != null && e.page < pageNo) before = e
  if (before) return before.text.trim()
  return of[0]?.text.trim() ?? ''
}
