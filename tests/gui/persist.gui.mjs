/**
 * P2 持久化最小探针:启动 → 分割一次 → 关闭 → 重启 → 验证 pane 结构恢复。
 * NEXUS_TEST_USERDATA 隔离真实用户数据;带进程退出/stderr 捕获。
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mk = (tag, userData) => {
  const appP = electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, NEXUS_TEST_USERDATA: userData }
  })
  appP.then((app) => {
    app.process().on('exit', (code) => console.log(`[${tag}] electron exit code=${code}`))
    app.process().stderr?.on('data', (d) => console.log(`[${tag}][stderr]`, d.toString().slice(0, 300)))
    app.process().stdout?.on('data', (d) => {
      const t = d.toString()
      if (/CRITICAL|Uncaught|pageerror/i.test(t)) console.log(`[${tag}][stdout]`, t.slice(0, 300))
    })
  }).catch((e) => console.log(`[${tag}] launch fail`, String(e).slice(0, 200)))
  return appP
}

const mkPage = async (tag, app) => {
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log(`[${tag}][pageerror]`, String(e).slice(0, 300)))
  win.on('console', (m) => { if (m.text().includes('TEMP-D2')) console.log(`[${tag}]`, m.text()) })
  await win.waitForSelector('[data-testid="split-renderer"]', { timeout: 20000 })
  await win.waitForTimeout(2000)
  return win
}

const userData = mkdtempSync(join(tmpdir(), 'nexus-persist-'))
const app1 = await mk('app1', userData)
const w1 = await mkPage('app1', app1)

await w1.locator('button[aria-label="Split right"]').first().click()
await w1.waitForTimeout(500)
const c1 = await w1.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').count()
console.log('after split =', c1)

await app1.close()
console.log('app1 closed; launching app2...')
const app2 = await mk('app2', userData)
const w2 = await mkPage('app2', app2)

const c2 = await w2.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').count()
console.log('after restart =', c2)
console.log(c2 === c1 ? 'PASS 持久化恢复' : `FAIL 持久化: ${c1} -> ${c2}`)
await app2.close()
rmSync(userData, { recursive: true, force: true })
process.exit(c2 === c1 ? 0 : 1)
