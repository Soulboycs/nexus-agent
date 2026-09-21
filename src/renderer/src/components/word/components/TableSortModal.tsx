import { useMemo, useState } from 'react'
import { useI18n } from '../i18n/locale'
import { useModalKeys } from './modal-keys'
import { findTableAtSelection, sortTableByColumn } from '../editor/table-sort'

/**
 * Word's Sort dialog for tables: pick the column (labelled by the header row
 * when present), direction, and whether the first row is a title row that
 * stays pinned. Applies as one undoable transaction.
 */
export function TableSortModal({
  editor,
  onClose,
}: {
  editor: import('@tiptap/core').Editor
  onClose: () => void
}) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  const info = useMemo(() => {
    const found = findTableAtSelection(editor)
    if (!found) return null
    const first = found.table.firstChild
    const labels: string[] = []
    const hasHeaderRow = !!first && first.firstChild?.type.name === 'docTableHeader'
    const firstRow = first
    firstRow?.forEach((cell) => labels.push(cell.textContent.trim()))
    const colCount = Math.max(1, firstRow ? firstRow.childCount : 1)
    return { hasHeaderRow, labels, colCount }
  }, [editor])

  const [col, setCol] = useState(0)
  const [asc, setAsc] = useState(true)
  const [hasHeader, setHasHeader] = useState(info?.hasHeaderRow ?? false)

  if (!info) return null

  const apply = () => {
    sortTableByColumn(editor, { col, asc, hasHeader })
    onClose()
  }

  return (
    <div
      className="modal-backdrop"
      ref={modalKeys.ref}
      onKeyDown={modalKeys.onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <h2>{t('ribbonSort')}</h2>
        <label>
          {t('appSortColumn')}
          <select value={col} onChange={(e) => setCol(Number(e.target.value))}>
            {Array.from({ length: info.colCount }, (_, i) => (
              <option key={i} value={i}>
                {info.hasHeaderRow && info.labels[i] ? info.labels[i] : t('appSortColumnN', { n: i + 1 })}
              </option>
            ))}
          </select>
        </label>
        <label className="modal-radio">
          <input type="radio" checked={asc} onChange={() => setAsc(true)} />
          {t('appSortAsc')}
        </label>
        <label className="modal-radio">
          <input type="radio" checked={!asc} onChange={() => setAsc(false)} />
          {t('appSortDesc')}
        </label>
        <label className="modal-check">
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => setHasHeader(e.target.checked)}
          />
          {t('appSortHasHeader')}
        </label>
        <div className="modal-actions">
          <button onClick={apply}>{t('appOk')}</button>
          <button onClick={onClose}>{t('appCancel')}</button>
        </div>
      </div>
    </div>
  )
}
