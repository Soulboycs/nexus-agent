/** 取路径的文件名(正反斜杠兼容);空串安全 */
export function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}
