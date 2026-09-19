/**
 * 路径身份契约(计划 §6.3/R12):路径即文档身份证,联动表 key 统一用本文件产出。
 *
 * - renderer 表 key:normalizeKeyPath(语法形规范化,零 IO);
 * - main 边界:canonicalizePath(fs.realpath.native 解析 8.3 短名/软链/规范大小写),
 *   返回 canonical 后,两端各自 normalizeKeyPath 即必然对齐。
 */

const WSL_PREFIXES = ['//wsl$/', '//wsl.localhost/']

/** 联动表 key 形态:正斜杠 + 全小写;WSL UNC(对端 ext4 大小写敏感)仅统一分隔符、保留原大小写 */
export function normalizeKeyPath(p: string): string {
  let s = String(p ?? '').trim().replace(/^"|"$/g, '')
  if (s.toLowerCase().startsWith('file://')) s = s.slice(7)
  if (s.startsWith('file:')) s = s.slice(5)
  s = s.replace(/\\/g, '/')
  // file:///D:/... 形态:剥掉盘符前的空 authority 斜杠
  s = s.replace(/^\/+(?=[A-Za-z]:\/)/, '')
  const lower = s.toLowerCase()
  for (const prefix of WSL_PREFIXES) {
    if (lower.startsWith(prefix)) return s // Linux 侧大小写敏感:保持原样
  }
  return lower
}

/** 等价判定:两端各自 normalize 后比较 */
export function samePath(a: string, b: string): boolean {
  return normalizeKeyPath(a) === normalizeKeyPath(b)
}

/**
 * [仅 main 进程] 边界规范化:解析真实路径(短名/符号链接/大小写)。
 * 文件不存在(新建文档)→ 返回 join 后的语法形,调用方无需特判。
 */
export async function canonicalizePath(
  p: string,
  workspaceRoot: string,
  io?: { realpath(p: string): Promise<string>; join(...s: string[]): string; isAbsolute(p: string): boolean }
): Promise<string> {
  const impl =
    io ??
    ({
      realpath: (x: string) => import('fs/promises').then((m) => m.realpath(x)),
      join: (...s: string[]) => {
        // 避免 main 之外误用 node:path:此处仅在 main 运行,require 即可用
        const path = require('path') as typeof import('path')
        return path.join(...s)
      },
      isAbsolute: (x: string) => {
        const path = require('path') as typeof import('path')
        return path.isAbsolute(x)
      }
    } as typeof io & object)
  const abs = impl.isAbsolute(p) ? p : impl.join(workspaceRoot, p)
  try {
    return await impl.realpath(abs)
  } catch {
    return abs
  }
}
