/**
 * 多 Pane 工作台 实机 GUI E2E(Playwright _electron 驱动打包后的应用)
 * 场景:G1 启动/注册表 → G2 分割+落地页卡片 → T 终端实敲 → G4 双 pane __perf 压测+帧率
 *      → 拖拽(堆叠/边缘分割)→ 持久化(重启恢复)
 * 运行:node tests/gui/multipane.gui.mjs(需先 npm run build)
 */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync as ioWriteFileSync } from 'node:fs'

const results = []
const ok = (name, pass, extra = '') => {
  results.push({ name, pass, extra })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const userData = mkdtempSync(join(tmpdir(), 'nexus-gui-'))
process.env.NEXUS_PERF_PROBE = '1'

const app = await electron.launch({
  args: ['out/main/index.js'],
  cwd: process.cwd(),
  env: { ...process.env, NEXUS_TEST_USERDATA: userData }
})
app.process().stdout?.on('data', (d) => { const t = d.toString(); if (t.includes('TEMP')) console.log('[main1]', t.slice(0, 150)) })
const win = await app.firstWindow()
app.process().stdout?.on('data', (d) => { const t = d.toString(); if (/error|warn|DOC_CONFLICT|NO_LIVE/i.test(t)) console.log('[main]', t.slice(0, 200)) })
win.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)))
win.on('console', (m) => { if (m.type() === 'error' || m.text().includes('TEMP-D2')) console.log('[console]', m.text().slice(0, 160)) })
await win.waitForLoadState('domcontentloaded')

// 启用性能探针(应用读取 localStorage 门)
await win.addInitScript(() => localStorage.setItem('nexus_perf_probe', '1'))
await win.reload()
await win.waitForSelector('[data-testid="split-renderer"]', { timeout: 20000 })
await win.waitForTimeout(1500)

const paneCount = () => win.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').count()

try {
  // G1 启动 + 注册表(标题不回退 Untitled)
  const chips = win.locator('[data-testid^="tab-tab_"]')
  await chips.first().waitFor({ timeout: 10000 })
  const title = await chips.first().textContent()
  ok('G1 启动:chip 有注册表标题(非 Untitled)', !/Untitled/i.test(title || ''), `title=${title}`)

  // G2 一键右侧分割 → 落地页 5 张卡
  await win.locator('button[aria-label="Split right"]').first().click()
  await win.waitForTimeout(600)
  const c2 = await paneCount()
  ok('G2 右侧分割 → 2 pane', c2 === 2, `count=${c2}`)
  const landing = win.locator('[data-testid="new-tab-landing"]')
  const landingVisible = (await landing.count()) > 0
  for (const card of ['chat', 'word', 'terminal', 'browser', 'review']) {
    const n = await win.locator(`[data-testid="new-tab-card-${card}"]`).count()
    ok(`G2 落地页卡片:${card}`, landingVisible && n >= 1)
  }

  // T1 终端:点终端卡 → 实敲 echo
  await win.locator('[data-testid="new-tab-card-terminal"]').click()
  await win.waitForTimeout(600)
  const term = win.locator('[data-testid="terminal-pane"]')
  ok('T1 终端 pane 挂载', (await term.count()) >= 1)
  if ((await term.count()) >= 1) {
    await term.first().click()
    await win.keyboard.type('echo gui_e2e_hello', { delay: 30 })
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1500)
  console.log('INFO perf gate =', await win.evaluate(() => localStorage.getItem('nexus_perf_probe')))
  app.process().stdout?.on('data', (d) => { const t = d.toString(); if (t.includes('__perf')) console.log('[main]', t.slice(0, 120)) })
    const text = await term.first().textContent()
    ok('T1 终端实敲 echo 有输出', /gui_e2e_hello/.test(text || ''))
  }

  // T3 审查:再分割 → 审查卡
  await win.locator('button[aria-label="Split right"]').first().click()
  await win.waitForTimeout(400)
  await win.locator('[data-testid="new-tab-card-review"]').click()
  await win.waitForTimeout(800)
  const review = win.locator('[data-testid="review-pane"]')
  ok('T3 审查 pane 挂载(真实文件树/会话列表)', (await review.count()) >= 1)

  // T2 浏览器:再分割 → 浏览器卡(只验证挂载与地址栏,不依赖外网)
  await win.locator('button[aria-label="Split right"]').first().click()
  await win.waitForTimeout(400)
  await win.locator('[data-testid="new-tab-card-browser"]').click()
  await win.waitForTimeout(600)
  ok('T2 浏览器 pane 挂载', (await win.locator('[data-testid="browser-pane"]').count()) >= 1)

  // G4 双 chat pane __perf 压测:开两个会话 pane,各发一条 __perf
  // 收敛布局:关闭多余 pane,只留两个 chat
  // 直接开两个新会话:用“+”按钮两次(新会话开进聚焦 pane)
  const chatPanes = win.locator('[data-testid^="chat-pane-"]')
  const before = await chatPanes.count()
  for (let i = before; i < 2; i++) {
    await win.locator('button[aria-label="New chat tab"]').first().click()
    await win.waitForTimeout(600)
  }
  const ids = await win.locator('[data-testid^="chat-pane-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid').replace('chat-pane-', ''))
  )
  ok('G4 两个 chat pane 就位', ids.length >= 2, ids.join(','))

  for (const sid of ids.slice(0, 2)) {
    await win.locator(`[data-testid="chat-pane-${sid}"] textarea`).first().click()
    await win.keyboard.type('__perf 压测', { delay: 10 })
    await win.keyboard.press('Enter')
  }
  for (let t = 0; t < 5; t++) {
    await win.waitForTimeout(2000)
    for (const sid of ids.slice(0, 2)) {
      const loc = win.locator(`[data-testid="chat-pane-${sid}"]`)
      const vis = await loc.isVisible().catch(() => 'gone')
      const txt = ((await loc.textContent().catch(() => '')) || '').replace(/\s+/g, ' ')
      console.log(`INFO poll${t} [${sid.slice(0, 8)}] vis=${vis} len=${txt.length} head=${JSON.stringify(txt.slice(0, 90))}`)
    }
  }
  const probe = await win.evaluate(() => window.__frameProbe?.stats?.() ?? null)
  ok(
    'G4 帧率探针可用且有采样',
    !!probe && probe.frames > 0,
    probe ? `frames=${probe.frames} max=${probe.max}ms p99=${probe.p99}ms` : 'no probe'
  )
  console.log(`INFO  帧率(max<50 目标): max=${probe?.max}ms p99=${probe?.p99}ms frames=${probe?.frames}`)

  // 双 pane 文本隔离:两个 chat pane 都收到流(各自内容非空)
  let streamed = 0
  for (const sid of ids.slice(0, 2)) {
    const t = await win.locator(`[data-testid="chat-pane-${sid}"]`).textContent()
    if (t && t.includes('x')) streamed++
  }
  ok('G4 两个会话各自收到合成流', streamed === 2, `streamed=${streamed}`)

  // 渲染计数:Profiler per-pane 计数存在(跨 pane 零渲染的量化基础)
  const counts = await win.evaluate(() => window.__renderCounts ?? null)
  ok('G4 Profiler 渲染计数可用', !!counts && Object.keys(counts).length >= 2, JSON.stringify(counts))

  // 拖拽:把第二个 chat 的 tab 拖到第一个 pane 中央 → 堆叠(第一个 pane tab 数 +1)
  const paneLoc = win.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').first()
  const chip = win.locator('[data-testid^="tab-tab_"]').nth(1)
  const paneBox = await paneLoc.boundingBox()
  const chipBox = await chip.boundingBox()
  if (paneBox && chipBox) {
    await win.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2)
    await win.mouse.down()
    await win.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2, { steps: 12 })
    await win.mouse.up()
    await win.waitForTimeout(500)
    const tabsInFirst = await win
      .locator('[data-testid^="pane-"]')
      .first()
      .locator('[data-testid^="tab-tab_"]')
      .count()
    ok('拖拽:chip 拖入中央 → 堆叠为 2 tab', tabsInFirst === 2, `tabsInFirst=${tabsInFirst}`)
  } else {
    ok('拖拽:chip 拖入中央', false, 'boundingBox 不可用')
  }

  // 持久化:重启应用 → pane 数恢复
  const panesBeforeClose = await paneCount()
  console.log('INFO 关闭前 pane testids =', await win.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).join(',')))
  const layoutRaw = await win.evaluate(() => localStorage.getItem('nexus_workspace_layout') || '')
  ioWriteFileSync('tests/gui/.layout-before.json', layoutRaw)
  console.log('INFO 关闭前 layout 长度 =', layoutRaw.length)
  await app.close()
  const app2 = await electron.launch({
    args: ['out/main/index.js'],
    cwd: process.cwd(),
    env: { ...process.env, APPDATA: userData }
  })
  await app2.context().addInitScript(() => {
    const orig = localStorage.setItem.bind(localStorage)
    window.__lsLog = []
    localStorage.setItem = (k, v) => {
      if (k === 'nexus_workspace_layout') window.__lsLog.push((v || '').length)
      orig(k, v)
    }
  })
  const win2 = await app2.firstWindow()
  win2.on('console', (m) => { if (m.text().includes('TEMP-D2')) console.log('[app2]', m.text().slice(0, 160)) })
  await win2.waitForSelector('[data-testid="split-renderer"]', { timeout: 20000 })
  console.log('[app2] t0 raw layout len =', await win2.evaluate(() => (localStorage.getItem('nexus_workspace_layout') || '').length))
  await win2.waitForTimeout(1000)
  console.log('[app2] t1 raw layout len =', await win2.evaluate(() => (localStorage.getItem('nexus_workspace_layout') || '').length))
  console.log('[app2] 写入历史 =', await win2.evaluate(() => (window.__lsLog || []).join(',')))
  await win2.waitForTimeout(2000)
  const panesAfter = await win2.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').count()
  console.log('INFO 重启后 pane testids =', await win2.locator('[data-testid^="pane-"]:has([data-testid^="tabbar-"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).join(',')))
  const layoutRaw2 = await win2.evaluate(() => localStorage.getItem('nexus_workspace_layout') || '')
  ioWriteFileSync('tests/gui/.layout-after.json', layoutRaw2)
  console.log('INFO 重启后 layout 长度 =', layoutRaw2.length)
  ok('持久化:重启后 pane 结构恢复', panesAfter === panesBeforeClose, `before=${panesBeforeClose} after=${panesAfter}`)
  await app2.close()
} catch (err) {
  ok('E2E 未捕获异常', false, String(err).slice(0, 300))
  try {
    await app.close()
  } catch {}
}

const failed = results.filter((r) => !r.pass)
console.log(`\n==== GUI E2E 汇总:${results.length - failed.length}/${results.length} 通过 ====`)
for (const f of failed) console.log('FAIL:', f.name, f.extra)
rmSync(userData, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
