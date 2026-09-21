/**
 * Word Chinese and standard font sizes mapping and parsing.
 * Aligns with Microsoft Word Chinese version (初号 ~ 八号) and ECMA-376 half-points.
 */

export const CHINESE_FONT_SIZE_MAP: Record<string, number> = {
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
  六号: 7.5,
  小六: 6.5,
  七号: 5.5,
  八号: 5,
}

export const PT_TO_CHINESE_FONT_SIZE: Record<number, string> = {
  42: '初号',
  36: '小初',
  26: '一号',
  24: '小一',
  22: '二号',
  18: '小二',
  16: '三号',
  15: '小三',
  14: '四号',
  12: '小四',
  10.5: '五号',
  9: '小五',
  7.5: '六号',
  6.5: '小六',
  5.5: '七号',
  5: '八号',
}

/** Complete Word font size list with both Chinese standard sizes and points */
export const FONT_SIZES: number[] = [
  5, 5.5, 6.5, 7.5, 8, 9, 10, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 42, 48, 72,
]

/** Parse user input which could be a Chinese name ('小四', '五号') or a number ('12', '10.5') */
export function parseFontSizeInput(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed in CHINESE_FONT_SIZE_MAP) {
    return CHINESE_FONT_SIZE_MAP[trimmed]
  }
  const num = Number(trimmed)
  if (Number.isFinite(num) && num > 0) {
    return num
  }
  return null
}

/** Format font size for display: in Chinese mode returns '五号' / '小四', otherwise returns number */
export function formatFontSizeDisplay(pt: number, lang?: string): string {
  if (lang == null || lang.startsWith('zh')) {
    const zh = PT_TO_CHINESE_FONT_SIZE[pt]
    if (zh) return zh
  }
  return String(pt)
}
