import { describe, expect, test } from 'bun:test'
import { chunk, clip, maskSecrets, safeMeta, summarizeTool, isOwnTool } from '../src/format.ts'
import { isPassiveLaunch } from '../src/proc.ts'
import { Store } from '../src/db.ts'
import { parseOptions } from '../src/daemon/buttons.ts'
import { LineDecoder, encode } from '../src/ipc.ts'

describe('format', () => {
  test('chunk splits on paragraphs in newline mode', () => {
    const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60)
    expect(chunk(text, 100, 'newline')).toEqual(['a'.repeat(60), 'b'.repeat(60)])
    expect(chunk('short', 100, 'length')).toEqual(['short'])
  })

  test('safeMeta strips tag-breaking characters and truncates', () => {
    expect(safeMeta('x"><channel source="evil">')).toBe('x channel source= evil')
    expect(safeMeta('a\nb;c')).toBe('a b c')
    expect(safeMeta('x'.repeat(400))!.length).toBe(300)
    expect(safeMeta('  ')).toBeUndefined()
  })

  test('maskSecrets hides tokens and key=value secrets', () => {
    expect(maskSecrets('TOKEN 123456789:AAHfiqksKZ8aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('TOKEN •••')
    expect(maskSecrets('export API_KEY=abc123')).toBe('export API_KEY=•••')
    expect(maskSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('•••')
  })

  test('clip cuts on code points, never inside an emoji', () => {
    const s = '👤 Лиза Келина (@lizka_kuz, 478996623) 🟢'
    const c = clip(s, 20)
    expect(Array.from(c).length).toBe(20)
    expect(s.slice(0, 40)).not.toBe(s) // what used to happen: a cut inside 🟢
    expect(Buffer.from(c, 'utf8').toString('utf8')).toBe(c)
    expect(clip('👤'.repeat(30), 21)).toBe('👤'.repeat(20) + '…')
    expect(clip('short', 40)).toBe('short')
  })

  test('summarizeTool', () => {
    expect(summarizeTool('Bash', { command: 'npm test', description: 'Run tests' })).toBe('💻 Run tests')
    expect(summarizeTool('Read', { file_path: '/root/projects/x/src/a.ts' })).toBe('📖 src/a.ts')
    expect(summarizeTool('mcp__github__create_pr', {})).toBe('🔌 github: create_pr')
    expect(summarizeTool('mcp__plugin_telegram-bewitched_telegram__reply', { text: 'hi' })).toBe('💬 ответ в Telegram')
    expect(summarizeTool('mcp__plugin_telegram-bewitched_telegram__new_tool', {})).toBe('🔌 plugin_telegram-bewitched_telegram: new_tool')
    expect(isOwnTool('mcp__plugin_telegram-bewitched_telegram__reply')).toBe(true)
    expect(isOwnTool('Bash')).toBe(false)
  })
})

describe('passive launch detection', () => {
  test('print mode is passive', () => {
    expect(isPassiveLaunch(['claude', '-p', 'hi', '--dangerously-load-development-channels', 'plugin:telegram-bewitched@bewitched'])).toBe(true)
  })
  test('channel flag naming this plugin is active', () => {
    expect(isPassiveLaunch(['claude', '--dangerously-load-development-channels', 'plugin:telegram-bewitched@bewitched', '--continue'])).toBe(false)
  })
  test('other channels or no flag are passive', () => {
    expect(isPassiveLaunch(['claude', '--channels', 'plugin:telegram@claude-plugins-official'])).toBe(true)
    expect(isPassiveLaunch(['claude'])).toBe(true)
  })
})

describe('store', () => {
  test('history, search, topics, pending', () => {
    const s = new Store(':memory:')
    const base = { thread_id: 7, from_id: '1', from_name: 'den', kind: 'text', file_id: null, reply_to: null, quote: null, forward: null }
    s.addMessage({ ...base, chat_id: '-1', message_id: 1, direction: 'in', date: 100, text: 'привет мир' })
    s.addMessage({ ...base, chat_id: '-1', message_id: 2, direction: 'out', date: 101, text: 'ответ про "кавычки"' })
    s.addMessage({ ...base, chat_id: '-1', thread_id: 8, message_id: 3, direction: 'in', date: 102, text: 'другой топик' })
    expect(s.history('-1', 7, 10).map(m => m.message_id)).toEqual([1, 2])
    expect(s.search('мир', 10, '-1', 7).map(m => m.message_id)).toEqual([1])
    expect(s.search('"кавычки', 10).length).toBe(1)
    expect(s.getMessage('-1', 3)?.text).toBe('другой топик')

    s.upsertTopic({ chat_id: '-1', thread_id: 7, name: 'proj', kind: 'project', project_key: '/p', status: 'active', created_at: 1, last_activity_at: 1 })
    expect(s.topicForProject('-1', '/p')?.thread_id).toBe(7)
    expect(s.topicByName('-1', 'PROJ')?.thread_id).toBe(7)
    expect(s.topicByName('-1', '7')?.name).toBe('proj')

    s.addPending('/p', 'hi', { user: 'den' })
    expect(s.takePending('/p', 72)).toHaveLength(1)
    expect(s.takePending('/p', 72)).toHaveLength(0)
    s.set('k', 'v')
    expect(s.get('k')).toBe('v')
    s.set('k', null)
    expect(s.get('k')).toBeNull()
  })
})

describe('buttons', () => {
  test('parseOptions accepts strings and objects', () => {
    expect(parseOptions(['Да', { label: 'Нет', style: 'danger' }])).toEqual([{ label: 'Да' }, { label: 'Нет', value: undefined, style: 'danger' }])
    expect(() => parseOptions([])).toThrow()
    expect(() => parseOptions('x')).toThrow()
    expect(parseOptions([{ label: 'x', style: 'weird' }])[0].style).toBeUndefined()
  })
})

describe('ipc', () => {
  test('LineDecoder reassembles split lines', () => {
    const d = new LineDecoder()
    const msg = encode({ t: 'ping' })
    expect(d.push(msg.slice(0, 5))).toEqual([])
    expect(d.push(msg.slice(5) + encode({ t: 'pong' }))).toEqual([{ t: 'ping' }, { t: 'pong' }])
  })
})

describe('projectTitle', async () => {
  const { projectTitle } = await import('../src/daemon/report.ts')
  test('topic or group title over the id folder; a folder by hand keeps its name', () => {
    const s = (o: object) => ({ projectName: '1004291818146-37', topic: null, group: null, ...o }) as never
    expect(projectTitle(s({ topic: { chatId: '-1004291818146', threadId: 37, name: 'telegram_bewitched_plugin' } }))).toBe('telegram_bewitched_plugin')
    expect(projectTitle(s({ topic: { chatId: '-1', threadId: 2, name: '🗄 old' } }))).toBe('old')
    expect(projectTitle(s({ group: { chatId: '-200700', title: 'Test Group' } }))).toBe('Test Group')
    expect(projectTitle(s({ projectName: 'my-repo' }))).toBe('my-repo')
  })
})

describe('launch', async () => {
  const { slugify, projectPath, launchCommand } = await import('../src/daemon/launch.ts')
  test('launch command: -n only for a safe name, then --resume or --continue', () => {
    const { settings } = require('../src/config.ts')
    expect(launchCommand({ name: 'claude-project-1004291818146-37', continue: true })).toBe(`${settings.launchCmd} -n claude-project-1004291818146-37 --continue`)
    expect(launchCommand({ name: 'x; rm -rf ~', resume: 'abc-1' })).toBe(`${settings.launchCmd} --resume abc-1`)
    expect(launchCommand({})).toBe(settings.launchCmd)
  })
  test('own tmux sessions: attach target, screen code and back', async () => {
    const { attachTarget, windowCode, windowTarget } = await import('../src/daemon/launch.ts')
    const { tmuxTarget } = await import('../src/daemon/screen.ts')
    const { settings } = require('../src/config.ts')
    expect(attachTarget('3')).toBe(`${settings.tmuxSession}:3`)
    expect(attachTarget('claude-user-478996623:0')).toBe('claude-user-478996623')
    expect(attachTarget('claude-project-1004291818146-37:1')).toBe('claude-project-1004291818146-37:1')
    expect(windowTarget('claude-user-1:0')).toBe('claude-user-1:0')
    expect(windowCode('3')).toBe('w3')
    expect(windowCode('claude-project-1004291818146-37:0')).toBe('sclaude-project-1004291818146-37.0')
    expect(tmuxTarget('sclaude-project-1004291818146-37.0')).toBe('=claude-project-1004291818146-37:0')
    expect(tmuxTarget('scodex-project-1004291818146-917.0')).toBe('=codex-project-1004291818146-917:0')
    expect(windowCode('codex-user-140211098:0')).toBe('scodex-user-140211098.0')
    expect(attachTarget('codex-user-140211098:0')).toBe('codex-user-140211098')
    expect(tmuxTarget('sother.0')).toBeNull()
    expect(tmuxTarget('sclaude-x;rm.0')).toBeNull()
  })
  test('slugify keeps letters of any script, drops path tricks', () => {
    expect(slugify('Мой Проект!')).toBe('Мой-Проект')
    expect(slugify('../../etc/passwd')).toBe('etcpasswd')
    expect(slugify('...')).toBe('')
    expect(slugify('my_app.v2')).toBe('my_app.v2')
  })
  test('projectPath puts names under PROJECTS_DIR', () => {
    expect(projectPath('demo')).toBe(`${process.env.PROJECTS_DIR}/demo`)
    expect(projectPath('/opt/x/../y')).toBe('/opt/y')
    expect(projectPath('  ')).toBeNull()
  })
})

describe('remote control detection', async () => {
  const { rcFromArgv, rcFromPane, rcFromSettings } = await import('../src/daemon/remote.ts')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')

  test('launch flags', () => {
    expect(rcFromArgv(['claude', '--rc'])).toBe(true)
    expect(rcFromArgv(['claude', '--remote-control', 'My Project'])).toBe(true)
    expect(rcFromArgv(['claude', 'remote-control', '--name', 'x'])).toBe(true)
    expect(rcFromArgv(['claude', '--continue', 'remote-control'])).toBe(false)
    expect(rcFromArgv(['claude', '--dangerously-load-development-channels', 'plugin:telegram-bewitched@bewitched'])).toBe(false)
  })

  test('status line of the pane, not the conversation above it', () => {
    expect(rcFromPane('…\n> \n  ⏵⏵ auto mode on · /rc active\n')).toBe(true)
    expect(rcFromPane('we talked about /rc active here\n' + 'x\n'.repeat(10))).toBe(false)
  })

  test('auto-connect setting; project false wins', () => {
    const conf = mkdtempSync(join(tmpdir(), 'rc-conf-'))
    const proj = mkdtempSync(join(tmpdir(), 'rc-proj-'))
    expect(rcFromSettings(proj, conf)).toBe(false)
    writeFileSync(join(conf, 'settings.json'), JSON.stringify({ remoteControlAtStartup: true }))
    expect(rcFromSettings(proj, conf)).toBe(true)
    mkdirSync(join(proj, '.claude'))
    writeFileSync(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ remoteControlAtStartup: false }))
    expect(rcFromSettings(proj, conf)).toBe(false)
  })
})

describe('session card details', async () => {
  const { permissionMode } = await import('../src/daemon/report.ts')
  test('permission mode: live status line first, then the hook value', () => {
    expect(permissionMode('> \n  ⏵⏵ auto mode on (shift+tab to cycle)\n', 'default')).toBe('auto')
    expect(permissionMode('  ⏸ plan mode on\n', null)).toBe('plan')
    expect(permissionMode('  ⏵⏵ accept edits on\n', null)).toBe('accept edits')
    expect(permissionMode(null, 'bypassPermissions')).toBe('bypass permissions')
    expect(permissionMode('> \n  ? for shortcuts\n', null)).toBe('обычный')
    expect(permissionMode(null, null)).toBeNull()
  })
})

describe('transcript', async () => {
  const { transcriptInfo } = await import('../src/daemon/transcript.ts')
  const { remoteControl } = await import('../src/daemon/remote.ts')
  const { mkdtempSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')

  test('reads the latest records across chunk boundaries', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'tr-')), 't.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } })
    writeFileSync(f, [
      JSON.stringify({ type: 'attachment', attachment: { type: 'remote_session_change', url: 'https://claude.ai/code/old' } }),
      JSON.stringify({ type: 'custom-title', customTitle: 'srv' }),
      ...Array(600).fill(filler),
      JSON.stringify({ type: 'attachment', attachment: { type: 'remote_session_change', url: null } }),
      JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 2 } } }),
      ...Array(300).fill(filler),
    ].join('\n') + '\n')
    const info = await transcriptInfo(f)
    expect(info).toEqual({ model: 'm', tokens: 3, remoteUrl: null, title: 'srv' })
  })

  test('transcript wins over other signals; nothing recorded falls back to flags', () => {
    expect(remoteControl(['claude', '--rc'], '/', null, null)).toEqual({ on: false, via: null })
    expect(remoteControl(['claude'], '/', null, 'https://claude.ai/code/s')).toEqual({ on: true, via: 'transcript', url: 'https://claude.ai/code/s' })
    expect(remoteControl(['claude', '--rc'], '/', null, undefined)).toEqual({ on: true, via: 'flag' })
  })
})

describe('transcript guess', async () => {
  const { guessTranscript, projectTranscriptDir } = await import('../src/daemon/transcript.ts')
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('fs')
  const { tmpdir } = await import('os')
  const { join } = await import('path')

  test('--resume names the file, --continue picks the newest, otherwise unknown', () => {
    const conf = mkdtempSync(join(tmpdir(), 'gt-'))
    expect(projectTranscriptDir('/root/projects/telegram_bewitched_plugin', conf)).toBe(join(conf, 'projects', '-root-projects-telegram-bewitched-plugin'))
    const dir = projectTranscriptDir('/w/p', conf)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old.jsonl'), '')
    writeFileSync(join(dir, 'new.jsonl'), '')
    utimesSync(join(dir, 'old.jsonl'), 1, 1)
    expect(guessTranscript(['claude', '--resume', 'abc-1'], '/w/p', conf)).toBe(join(dir, 'abc-1.jsonl'))
    expect(guessTranscript(['claude', '--continue'], '/w/p', conf)).toBe(join(dir, 'new.jsonl'))
    expect(guessTranscript(['claude'], '/w/p', conf)).toBeNull()
    expect(guessTranscript(['claude', '--resume', '../x'], '/w/p', conf)).toBeNull()
  })
})

describe('usage', async () => {
  const { parseLimits, planName, costOf } = await import('../src/daemon/usage.ts')

  test('limits: the old per-window shape, unknown fields ignored', () => {
    const l = parseLimits({ five_hour: { utilization: 12.5, resets_at: '2026-01-01T00:00:00Z' }, seven_day: { utilization: 3, resets_at: null }, seven_day_opus: null })
    expect(l.items.map(i => [i.label, i.percent, i.resetsAt?.toISOString() ?? null])).toEqual([
      ['5 часов', 12.5, '2026-01-01T00:00:00.000Z'], ['Неделя', 3, null],
    ])
    expect(l.breakdown).toBeNull()
    expect(parseLimits({ limits: [{ kind: 'weekly_new', scope: 'x', percent: 5 }] }).items[0].label).toBe('weekly_new (x)')
  })

  test('plan name and prices', () => {
    expect(planName({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' })).toBe('Pro')
    expect(planName({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' })).toBe('Max 5x')
    expect(planName(null)).toBeNull()
    const e = { id: '', ts: 0, cwd: '', input: 1e6, output: 1e6, write5m: 1e6, write1h: 1e6, read: 1e6 }
    expect(costOf({ ...e, model: 'claude-opus-5-5' })).toBeCloseTo(4 + 20 + 5 + 8 + 0.2)
    expect(costOf({ ...e, model: 'claude-sonnet-5-5' })).toBeCloseTo(2 + 10 + 2.5 + 4 + 0.2)
    expect(costOf({ ...e, model: 'claude-fable-5-1' })).toBeCloseTo(10 + 50 + 12.5 + 20 + 0.25)
    expect(costOf({ ...e, model: 'claude-haiku-5-5', input: 1000, write5m: 0, write1h: 0, read: 0 })).toBeCloseTo(0.0001 + 0.5)
    expect(costOf({ ...e, model: 'some-new-model' })).toBeNull()
  })
})

describe('screen', async () => {
  const { tmuxTarget, screenText } = await import('../src/daemon/screen.ts')
  test('targets: only pane and window codes', () => {
    expect(tmuxTarget('p12')).toBe('%12')
    expect(tmuxTarget('w3')).toBe('claude:3')
    expect(tmuxTarget('w3;kill')).toBeNull()
    expect(tmuxTarget('x1')).toBeNull()
  })
  test('screen text: trailing blanks dropped, secrets masked, last 40 lines', () => {
    expect(screenText('a  \nb\n\n\n   \n')).toBe('a\nb')
    expect(screenText('token=sk-ant-abcdefghijklmnopqrstuvwxyz0123')).not.toContain('abcdefghijklmnop')
    expect(screenText(Array.from({ length: 60 }, (_, i) => String(i)).join('\n')).split('\n')[0]).toBe('20')
  })
})

describe('reminders', async () => {
  const { parseWhen, fmtWhen } = await import('../src/daemon/reminders.ts')
  const now = new Date(2026, 9, 28, 20, 0, 0).getTime()
  test('relative, clock, tomorrow, daily', () => {
    expect(parseWhen('30m проверь CI', now)).toEqual({ at: now + 30 * 60_000, daily: false, text: 'проверь CI' })
    expect(parseWhen('1h30m x', now)!.at).toBe(now + 90 * 60_000)
    expect(parseWhen('2д x', now)!.at).toBe(now + 2 * 86_400_000)
    expect(parseWhen('через 2 часа выпить чаю', now)).toEqual({ at: now + 2 * 3_600_000, daily: false, text: 'выпить чаю' })
    expect(parseWhen('21:15 позвонить', now)!.at).toBe(new Date(2026, 9, 28, 21, 15).getTime())
    expect(parseWhen('19:00 x', now)!.at).toBe(new Date(2026, 9, 29, 19, 0).getTime())
    expect(parseWhen('завтра 9:00 стендап', now)).toEqual({ at: new Date(2026, 9, 29, 9, 0).getTime(), daily: false, text: 'стендап' })
    expect(parseWhen('каждый день 9:00 сводка почты', now)).toEqual({ at: new Date(2026, 9, 29, 9, 0).getTime(), daily: true, text: 'сводка почты' })
    expect(parseWhen('потом как-нибудь', now)).toBeNull()
    expect(parseWhen('25:00 x', now)).toBeNull()
    expect(fmtWhen({ at: new Date(2026, 9, 28, 21, 15).getTime(), daily: false }, now)).toBe('сегодня в 21:15')
    expect(fmtWhen({ at: new Date(2026, 9, 29, 9, 0).getTime(), daily: true }, now)).toBe('каждый день в 09:00')
  })
})

describe('period reports', async () => {
  const { lastPeriod, buckets } = await import('../src/daemon/reports.ts')
  const { columnChartSvg, svgToPng } = await import('../src/daemon/chart.ts')
  const at = new Date(2026, 9, 28, 0, 5) // Wed 28 Oct 2026, just after midnight
  test('last complete day, week (Mon–Sun) and month', () => {
    const day = lastPeriod('day', at)
    expect([day.start, day.end]).toEqual([new Date(2026, 9, 27), new Date(2026, 9, 28)])
    const week = lastPeriod('week', at)
    expect([week.start, week.end]).toEqual([new Date(2026, 9, 19), new Date(2026, 9, 26)])
    expect(lastPeriod('week', new Date(2026, 9, 26, 0, 1)).start).toEqual(new Date(2026, 9, 19))
    const month = lastPeriod('month', at)
    expect([month.start, month.end]).toEqual([new Date(2026, 8, 1), new Date(2026, 9, 1)])
    expect(lastPeriod('month', new Date(2026, 0, 3)).start).toEqual(new Date(2025, 11, 1))
  })
  test('buckets: 24 hours, 7 days, weeks of the month', () => {
    expect(buckets(lastPeriod('day', at)).length).toBe(24)
    expect(buckets(lastPeriod('week', at)).map(b => b.label)).toEqual(['Пн 19', 'Вт 20', 'Ср 21', 'Чт 22', 'Пт 23', 'Сб 24', 'Вс 25'])
    expect(buckets(lastPeriod('month', new Date(2026, 10, 2))).map(b => b.label)).toEqual(['1–7', '8–14', '15–21', '22–28', '29–31'])
    expect(buckets(lastPeriod('month', new Date(2026, 2, 2))).map(b => b.label)).toEqual(['1–7', '8–14', '15–21', '22–28'])
  })
  test('chart: peak labelled, PNG rendered', async () => {
    const svg = columnChartSvg({ title: 'T', subtitle: 'S', columns: [{ label: 'a', value: 1 }, { label: 'b', value: 3.5 }, { label: 'c', value: 0 }] })
    expect(svg).toContain('>$3.50</text>')
    expect(svg.match(/<path /g)?.length).toBe(2)
    const png = await svgToPng(svg)
    expect(png?.subarray(1, 4).toString()).toBe('PNG')
    expect(columnChartSvg({ title: 'T', subtitle: 'S', columns: [{ label: 'a', value: 0 }] })).toContain('Нет активности')
  })
})

describe('voice text', async () => {
  const { speakable } = await import('../src/voice/tts.ts')
  test('markdown, code and links are not read aloud', () => {
    expect(speakable('# Итог\n**Готово**: см. [PR](https://x.y/1) и `npm test`.\n```\ncode\n```\n- пункт')).toBe('Итог\nГотово: см. PR и npm test.\n (код в сообщении) \nпункт')
    expect(speakable('смотри https://example.com/a?b=1 тут')).toBe('смотри ссылка тут')
  })
})

describe('speech normalization', async () => {
  const { normalizeForSpeech: n, numberWords } = await import('../src/voice/normalize.ts')
  test('numbers in words', () => {
    expect(numberWords(77)).toBe('семьдесят семь')
    expect(numberWords(2021)).toBe('две тысячи двадцать один')
    expect(numberWords(1600)).toBe('тысяча шестьсот')
    expect(numberWords(1_000_001)).toBe('миллион один')
    expect(n('тесты 77 из 77, в 23:16')).toBe('тесты семьдесят семь из семьдесят семь, в двадцать три шестнадцать')
    expect(n('41%, 3.5, #36, 1.1.1, 09:05')).toBe('сорок один процент, три целых пять, номер тридцать шесть, один точка один точка один, девять ноль пять')
  })
  test('Latin read in Cyrillic', () => {
    expect(n('Claude Code и Telegram бот')).toBe('клод код и телеграм бот')
    expect(n('PR, CPU, GitHub, OpenAI, tmux')).toBe('пи-ар, си-пи-ю, гитхаб, оупен эй-ай, ти-макс')
    expect(n('large-v3-turbo')).toBe('лардж-ви три-турбо')
    expect(n('Привет')).toBe('Привет')
    expect(/[A-Za-z0-9]/.test(n('Random English words like Kubernetes and Postgres 15'))).toBe(false)
  })
})

describe('dates and quiet hours', async () => {
  const { normalizeForSpeech: n, dateWords } = await import('../src/voice/normalize.ts')
  const { isQuiet, parseQuiet } = await import('../src/daemon/quiet.ts')
  test('dates are read as dates; fractions and versions as before', () => {
    expect(n('29.10.2026')).toBe('двадцать девятое октября две тысячи двадцать шестого года')
    expect(n('01.01.2000')).toBe('первое января двухтысячного года')
    expect(n('23.02')).toBe('двадцать третье февраля')
    expect(dateWords(3, 3, 1903)).toBe('третье марта тысяча девятьсот третьего года')
    expect(dateWords(32, 1)).toBeNull()
    expect(n('3.5')).toBe('три целых пять')
    expect(n('1.2.0')).toBe('один точка два точка ноль')
    expect(n('в 18:30')).toBe('в восемнадцать тридцать')
  })
  test('quiet hours, also across midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m)
    expect(parseQuiet('off')).toBeNull()
    expect(parseQuiet('23:00-08:00')).toEqual([1380, 480])
    expect(isQuiet(parseQuiet('23:00-08:00'), at(23, 30))).toBe(true)
    expect(isQuiet(parseQuiet('23:00-08:00'), at(7, 59))).toBe(true)
    expect(isQuiet(parseQuiet('23:00-08:00'), at(8))).toBe(false)
    expect(isQuiet(parseQuiet('13:00-14:00'), at(13, 15))).toBe(true)
    expect(isQuiet(null, at(3))).toBe(false)
  })
})

describe('quick commands', async () => {
  const { parseMacro } = await import('../src/daemon/macros.ts')
  test('label | text', () => {
    expect(parseMacro(' 🧪 Тесты | прогони тесты ')).toEqual({ label: '🧪 Тесты', text: 'прогони тесты' })
    expect(parseMacro('без разделителя')).toBeNull()
    expect(parseMacro(' | текст')).toBeNull()
  })
})

describe('conversations', async () => {
  const { firstPrompt } = await import('../src/daemon/transcript.ts')
  const { mkdtempSync, writeFileSync } = await import('fs')
  const { tmpdir } = await import('os')
  test('the first thing said, without channel tags, resume digests and command wrappers', async () => {
    const f = `${mkdtempSync(`${tmpdir()}/conv-`)}/a.jsonl`
    const u = (content: unknown, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })
    writeFileSync(f, [
      JSON.stringify({ type: 'mode', mode: 'normal' }),
      u('<channel source="t" event="session_resume">Последние сообщения…</channel>'),
      u('<command-name>/compact</command-name>'),
      u('meta', { isMeta: true }),
      u('<channel source="t" chat_id="1">\nпочини   тесты\n</channel>'),
      u('second'),
    ].join('\n'))
    expect(await firstPrompt(f)).toBe('почини тесты')
  })
})

describe('i18n', async () => {
  const { DICTS, t, withLang, normLang, variants } = await import('../src/i18n/index.ts')
  const { translationKeys, rawCyrillic } = await import('../scripts/i18n-keys.ts')
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')

  test('every interface string is translated into every language, with the same placeholders', () => {
    const keys = translationKeys()
    expect(keys.size).toBeGreaterThan(500)
    for (const [lang, dict] of Object.entries(DICTS)) {
      const missing = [...keys].filter(k => !(k in dict))
      const stale = Object.keys(dict).filter(k => !keys.has(k))
      const broken = Object.entries(dict).filter(([k, v]) => holes(k) !== holes(v)).map(([k]) => k)
      expect({ lang, missing, stale, broken }).toEqual({ lang, missing: [], stale: [], broken: [] })
    }
  })

  test('no Russian left outside t()/k() (text for the model is marked i18n-ignore)', () => {
    expect(rawCyrillic()).toEqual([])
  })

  test('t: current language, placeholders, Russian fallback', () => {
    expect(withLang('en', () => t('Сессий: {n}', { n: 3 }))).toBe('Sessions: 3')
    expect(withLang('de', () => t('« Меню'))).toBe('« Menü')
    expect(withLang('ru', () => t('Сессий: {n}', { n: 3 }))).toBe('Сессий: 3')
    expect(withLang('fr', () => t('строка, которой нет в словаре'))).toBe('строка, которой нет в словаре')
    expect(normLang('zh-hans')).toBe('zh')
    expect(normLang('pt-br')).toBeNull()
    expect(variants('Отмена')).toEqual(expect.arrayContaining(['Отмена', 'Cancel', 'Abbrechen', '取消']))
  })
})

describe('rich (FR-11)', async () => {
  const { screenToRich, hardBreaks, richToMarkdown } = await import('../src/rich.ts')

  test('a screen gets a heading, a divider, sections and a footer', () => {
    const html = '📋 <b>Сессии</b> (2)\n1. 🟢 <b>a</b> · ok\n2. ⚪️ <b>b</b>\n\n💸 <b>Потребление</b>, в ценах API\n<blockquote>5 ч: 1\nСутки: 2</blockquote>\n\n<i>Стоимость — как в API.</i>'
    expect(screenToRich(html)).toBe('<h3>📋 Сессии (2)</h3><hr/><p>1. 🟢 <b>a</b> · ok<br>2. ⚪️ <b>b</b></p><h4>💸 Потребление, в ценах API</h4><blockquote>5 ч: 1<br>Сутки: 2</blockquote><footer>Стоимость — как в API.</footer>')
  })

  test('notices and one-liners are not screens', () => {
    expect(screenToRich('✅ <b>Готово</b>')).toBeNull()
    expect(screenToRich('⚠️ Сессия <b>x</b> (#1) остановилась.\nТопик закрыт.')).toBeNull()
    expect(screenToRich('Просто текст\nещё')).toBeNull()
  })

  test('pre blocks keep their newlines', () => {
    expect(screenToRich('🖥 <b>Сервер</b>\n<pre>a\n\nb</pre>')).toBe('<h3>🖥 Сервер</h3><hr/><pre>a\n\nb</pre>')
  })

  test('hardBreaks keeps single newlines, not in code, tables or before blocks', () => {
    expect(hardBreaks('a\nb\n\nc')).toBe('a  \nb\n\nc')
    expect(hardBreaks('```\nx\ny\n```')).toBe('```\nx\ny\n```')
    expect(hardBreaks('| a |\n| b |')).toBe('| a |\n| b |')
    expect(hardBreaks('Шаги:\n- раз\n- два')).toBe('Шаги:\n- раз\n- два')
    expect(hardBreaks('# T\n---')).toBe('# T\n---')
    expect(hardBreaks('> q1\n> q2')).toBe('> q1  \n> q2')
  })

  test('a received rich message becomes Markdown', () => {
    const rm = { blocks: [
      { type: 'heading', text: 'Demo', size: 2 },
      { type: 'divider' },
      { type: 'paragraph', text: ['a ', { type: 'bold', text: 'b' }, ' ', { type: 'code', text: 'c' }] },
      { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: 'x' }] }, { has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: 'y' }] }] },
      { type: 'pre', text: 'echo 1', language: 'php' },
      { type: 'table', cells: [[{ text: 'h' }, { text: 'v' }], [{ text: '1' }, { text: '2' }]] },
      { type: 'details', summary: 'More', blocks: [{ type: 'paragraph', text: 'inside' }] },
    ] }
    expect(richToMarkdown(rm)).toBe('## Demo\n\n---\n\na **b** `c`\n\n- x\n- [x] y\n\n```php\necho 1\n```\n\n| h | v |\n|---|---|\n| 1 | 2 |\n\n<details><summary>More</summary>\n\ninside\n\n</details>')
  })
})

describe('screen questions', () => {
  test('a numbered menu with the focus or «Enter to confirm» is a question; the plain prompt is not', async () => {
    const { isQuestion } = await import('../src/daemon/screen.ts')
    expect(isQuestion('   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5.5\n     2. No, go back')).toBe(true)
    expect(isQuestion('Rewind\n Enter to confirm · Esc to cancel')).toBe(true)
    expect(isQuestion('✻ Cooked for 18s\n────\n❯ \n────')).toBe(false)
    expect(isQuestion(null)).toBe(false)
  })
})

describe('typing into a session (FR-14)', () => {
  const idle = (input: string) => `✻ Cooked for 18s\n${'─'.repeat(40)}\n❯ ${input}\n${'─'.repeat(40)}\n  ⏵⏵ auto mode on`
  const fake = (screens: string[]) => {
    const runs: string[][] = []
    let i = 0
    return { runs, io: { run: async (a: string[]) => { runs.push(a); return '' }, capture: async () => screens[Math.min(i++, screens.length - 1)], sleep: async () => {} } }
  }

  test('the input line: after ❯ or ›, wrapped lines joined, spaces ignored', async () => {
    const { inputShows } = await import('../src/daemon/launch.ts')
    expect(inputShows(idle('/model claude-sonnet-5-5'), '/model claude-sonnet-5-5')).toBe(true)
    expect(inputShows(`❯ /model claude-son\n  net-5-5\n${'─'.repeat(9)}`, '/model claude-sonnet-5-5')).toBe(true)
    expect(inputShows('› /exit', '/exit')).toBe(true)
    expect(inputShows(idle(''), '/exit')).toBe(false)
    // A menu below the input: its ❯ is the last one, the text is not there.
    expect(inputShows(`${idle('/exit')}\n   Switch model?\n   ❯ 1. Yes`, '/exit')).toBe(false)
  })

  test('Enter goes only after the text shows up; nothing is typed while a question is open', async () => {
    const { tmuxType, InputBlocked } = await import('../src/daemon/launch.ts')
    const ok = fake([idle(''), idle(''), idle('/compact')])
    await tmuxType('%1', '/compact', ok.io)
    expect(ok.runs).toEqual([['send-keys', '-t', '%1', '-l', '/compact'], ['send-keys', '-t', '%1', 'Enter']])

    const asked = fake(['   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5.5\n     2. No, go back'])
    await expect(tmuxType('%1', '/exit', asked.io)).rejects.toBeInstanceOf(InputBlocked)
    expect(asked.runs).toEqual([])

    const swallowed = fake([idle('')])
    await expect(tmuxType('%1', '/exit', swallowed.io)).rejects.toBeInstanceOf(InputBlocked)
    expect(swallowed.runs.some(r => r.includes('Enter'))).toBe(false)
  })

  test('Codex folds a paste over 1000 chars into «[Pasted Content N chars]»: N is the proof the text is in; the first line is enough otherwise', async () => {
    const { inputShows } = await import('../src/daemon/launch.ts')
    const long = 'привет мир '.repeat(130)
    expect(inputShows(`  >_ OpenAI Codex\n› [Pasted Content ${[...long].length} chars]\n  GPT-6.1-Sol default`, long)).toBe(true)
    // A stuck paste of another text and this one after it: this one is there, Enter sends both.
    expect(inputShows(`› [Pasted Content 1274 chars][Pasted Content ${[...long].length} chars]`, long)).toBe(true)
    expect(inputShows('› [Pasted Content 1274 chars]', long)).toBe(false)
    expect(inputShows('› Ask Codex to do anything', long)).toBe(false)
    // A message with a blank line: the input box ends there, its first line is checked.
    expect(inputShows('› <channel source="telegram-bewitched" chat_id="1">\n  первое\n\n  GPT-6.1-Sol default', '<channel source="telegram-bewitched" chat_id="1">\nпервое\n\nвторое\n</channel>')).toBe(true)
  })

  test('paste: one bracketed paste through a private file (set-buffer refuses long text), then Enter once it shows', async () => {
    const { tmuxType } = await import('../src/daemon/launch.ts')
    const { existsSync, readFileSync } = await import('fs')
    const text = 'я'.repeat(5000)
    let file = ''
    let body = ''
    const runs: string[][] = []
    const io = {
      run: async (a: string[]) => { runs.push(a); if (a[0] === 'load-buffer') { file = a[3]; body = readFileSync(file, 'utf8') } return '' },
      capture: async () => (runs.some(r => r[0] === 'paste-buffer') ? '› [Pasted Content 5000 chars]' : '› Ask Codex to do anything'),
      sleep: async () => {},
    }
    await tmuxType('%7', text, io, { paste: true })
    expect(runs.map(r => r[0])).toEqual(['load-buffer', 'paste-buffer', 'send-keys'])
    expect(runs[1]).toEqual(['paste-buffer', '-p', '-d', '-b', runs[0][2], '-t', '%7'])
    expect(runs[2]).toEqual(['send-keys', '-t', '%7', 'Enter'])
    expect(body).toBe(text)
    expect(existsSync(file)).toBe(false)
  })
})

describe('engines (FR-15)', () => {
  test('Claude Code command: -n, --model (checked), --resume / --continue; unknown engines fall back to it', async () => {
    const { claude, engineOf } = await import('../src/daemon/engines.ts')
    const { settings } = await import('../src/config.ts')
    const base = settings.launchCmd
    expect(claude.launchCommand({})).toBe(base)
    expect(claude.launchCommand({ name: 'claude-project-x', model: 'claude-sonnet-5-5', continue: true })).toBe(`${base} -n claude-project-x --model claude-sonnet-5-5 --continue`)
    expect(claude.launchCommand({ model: 'x; rm -rf /', resume: 'abc-123' })).toBe(`${base} --resume abc-123`)
    expect(engineOf('nope')).toBe(claude)
    expect(claude.isModal('   Switch model?\n   ❯ 1. Yes')).toBe(true)
    expect(claude.isPromptReady('────\n❯ \n────')).toBe(true)
  })

  test('a project remembers its engine and model; launches take them unless the caller chose', async () => {
    const { projectEngine, setProjectEngine, withProjectEngine } = await import('../src/daemon/engines.ts')
    const d = { store: new Store(':memory:') } as never
    expect(projectEngine(d, '/p')).toEqual({ engine: 'claude' })
    expect(withProjectEngine(d, '/p', { name: 'n' })).toEqual({ engine: 'claude', name: 'n' })
    setProjectEngine(d, '/p', { engine: 'claude', model: 'claude-haiku-5-5' })
    expect(withProjectEngine(d, '/p', { continue: true })).toEqual({ engine: 'claude', model: 'claude-haiku-5-5', continue: true })
    expect(withProjectEngine(d, '/p', { model: 'claude-opus-5-5' }).model).toBe('claude-opus-5-5')
    // A model the engine does not offer (an old record) is dropped.
    ;(d as { store: Store }).store.set('engine:/p', JSON.stringify({ engine: 'claude', model: 'gpt-9' }))
    expect(projectEngine(d, '/p')).toEqual({ engine: 'claude' })
    setProjectEngine(d, '/p', { engine: 'claude' })
    expect(projectEngine(d, '/p')).toEqual({ engine: 'claude' })
  })
})

describe('Codex engine (FR-16)', () => {
  test('launch command with the bewitched profile, -m, resume / resume --last', async () => {
    const { codex } = await import('../src/daemon/engines.ts')
    const cmd = codex.launchCommand({ model: 'gpt-6.1-sol', name: 'ignored' })
    expect(cmd).toMatch(/codex --no-alt-screen -p bewitched -m gpt-6\.1-sol$/)
    expect(codex.launchCommand({ resume: '01a1-x' })).toMatch(/codex resume 01a1-x --no-alt-screen -p bewitched$/)
    expect(codex.launchCommand({ continue: true })).toMatch(/codex resume --last --no-alt-screen -p bewitched$/)
    expect(codex.launchCommand({ model: 'bad model' })).toMatch(/-p bewitched$/)
  })

  test('only a Codex started with the bewitched profile is ours; its questions use ›', async () => {
    const { isPassiveLaunch } = await import('../src/proc.ts')
    const { isQuestion } = await import('../src/daemon/screen.ts')
    expect(isPassiveLaunch(['/root/.local/bin/codex', '--no-alt-screen', '-p', 'bewitched'])).toBe(false)
    expect(isPassiveLaunch(['codex'])).toBe(true)
    expect(isPassiveLaunch(['codex', 'resume', 'abc', '--no-alt-screen', '-p', 'bewitched'])).toBe(false)
    // Checks with the profile start our MCP server too: not a session.
    expect(isPassiveLaunch(['codex', '-p', 'bewitched', 'debug', 'prompt-input'])).toBe(true)
    expect(isPassiveLaunch(['codex', '-p', 'bewitched', 'mcp', 'list'])).toBe(true)
    expect(isPassiveLaunch(['codex', '--no-alt-screen', '-p', 'bewitched', 'exec', 'hi'])).toBe(true)
    expect(isPassiveLaunch(['claude', '-p', 'hi'])).toBe(true)
    expect(isQuestion('  Trust this folder?\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit')).toBe(true)
    expect(isQuestion('  Hooks need review\n› 1. Review hooks\n  enter confirm · esc skip')).toBe(true)
    expect(isQuestion('› Ask Codex to do anything\n  GPT-6.1-Sol default · /work')).toBe(false)
  })

  test('a Telegram message as a <channel> block, without stream_answer', async () => {
    const { channelText } = await import('../src/daemon/engines.ts')
    expect(channelText('привет\nмир', { chat_id: '-100', user: 'a "b"', stream_answer: 'true' }))
      .toBe('<channel source="telegram-bewitched" chat_id="-100" user="a &quot;b&quot;">\nпривет\nмир\n</channel>')
  })
})

describe('Codex usage', () => {
  const line = (o: unknown) => JSON.stringify(o)
  const tc = (ts: string, input: number, cached: number, output: number, used = 2) => line({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
      rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1793555158 }, secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1794107405 }, plan_type: 'plus' } },
  })

  test('requests are the growth of the totals (repeats ignored); limits are the newest', async () => {
    const { parseRollout } = await import('../src/daemon/codexusage.ts')
    const text = [
      line({ timestamp: '2026-11-01T14:02:20Z', type: 'session_meta', payload: { cwd: '/p' } }),
      line({ timestamp: '2026-11-01T14:02:21Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
      tc('2026-11-01T14:02:29Z', 16_000, 12_000, 100),
      tc('2026-11-01T14:02:30Z', 16_000, 12_000, 100),
      tc('2026-11-01T14:02:33Z', 40_000, 30_000, 150, 3),
    ].join('\n')
    const { entries, limits } = parseRollout(text, 'f', 0)
    expect(entries.map(e => [e.model, e.cwd, e.input, e.read, e.output])).toEqual([['gpt-6.1-sol', '/p', 4_000, 12_000, 100], ['gpt-6.1-sol', '/p', 6_000, 18_000, 50]])
    expect(limits?.plan).toBe('plus')
    expect(limits?.items.map(i => [i.label, i.percent])).toEqual([['Codex: 5 часов', 3], ['Codex: неделя', 0]])
  })

  test('a window that has reset since the last request shows empty', async () => {
    const { freshCodexLimits } = await import('../src/daemon/usage.ts')
    const at = new Date('2026-11-01T17:45:58Z')
    const l = { at: 0, plan: 'plus', items: [{ label: 'Codex: 5 часов', percent: 40, resetsAt: at }] }
    expect(freshCodexLimits(l, at.getTime() - 1)[0].percent).toBe(40)
    expect(freshCodexLimits(l, at.getTime() + 1)[0]).toEqual({ label: 'Codex: 5 часов', percent: 0, resetsAt: null })
  })
})
