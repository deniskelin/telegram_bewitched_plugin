/**
 * Text for a Russian voice: Silero reads only Cyrillic, so digits and Latin
 * words are silently dropped. Numbers become words, Latin words a Cyrillic
 * reading (a dictionary of common ones, letters for abbreviations, English
 * reading rules for the rest).
 */

const ONES_M = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const ONES_F = ['ноль', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']
const SCALES: [string, string, string, boolean][] = [
  ['тысяча', 'тысячи', 'тысяч', true],
  ['миллион', 'миллиона', 'миллионов', false],
  ['миллиард', 'миллиарда', 'миллиардов', false],
]

/** 1 файл, 2 файла, 5 файлов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function under1000(n: number, feminine: boolean): string[] {
  const out: string[] = []
  if (n >= 100) out.push(HUNDREDS[Math.floor(n / 100)])
  const r = n % 100
  if (r >= 10 && r < 20) out.push(TEENS[r - 10])
  else {
    if (r >= 20) out.push(TENS[Math.floor(r / 10)])
    if (r % 10) out.push((feminine ? ONES_F : ONES_M)[r % 10])
  }
  return out
}

/** Whole number in words (up to 999 999 999 999). */
export function numberWords(n: number, feminine = false): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e12) return String(n).split('').map(c => ONES_M[Number(c)] ?? c).join(' ')
  if (n === 0) return 'ноль'
  const parts: string[] = []
  const groups: number[] = []
  for (let x = Math.floor(n); x > 0; x = Math.floor(x / 1000)) groups.push(x % 1000)
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]
    if (!g) continue
    if (i === 0) parts.push(...under1000(g, feminine))
    else {
      const [one, few, many, fem] = SCALES[i - 1]
      // "тысяча шестьсот", not "одна тысяча шестьсот"
      parts.push(...(g === 1 ? [] : under1000(g, fem)), plural(g, one, few, many))
    }
  }
  return parts.join(' ')
}

/** "3.5" → "три целых пять", "0.25" → "ноль целых двадцать пять". */
function decimalWords(int: string, frac: string): string {
  const i = Number(int)
  return `${numberWords(i, true)} ${plural(i, 'целая', 'целых', 'целых')} ${frac.length > 3 ? frac.split('').map(c => ONES_M[Number(c)]).join(' ') : numberWords(Number(frac))}`
}

// Ordinals: the day of a date (neuter nominative) and the year (genitive).
const ORD_ONES = ['', 'перв', 'втор', 'трет', 'четвёрт', 'пят', 'шест', 'седьм', 'восьм', 'девят']
const ORD_TEENS = ['десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат', 'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат']
const ORD_TENS = ['', '', 'двадцат', 'тридцат', 'сороков', 'пятидесят', 'шестидесят', 'семидесят', 'восьмидесят', 'девяност']
const ORD_HUNDREDS = ['', 'сот', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот']
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

/** Ordinal of 1..999, neuter nominative ('е' → "первое") or genitive ('ого' → "первого"); "третье", "третьего". */
function ordinal(n: number, ending: 'е' | 'ого'): string {
  const h = Math.floor(n / 100), r = n % 100
  const head: string[] = []
  let stem: string
  if (r === 0) stem = ORD_HUNDREDS[h]
  else {
    if (h) head.push(HUNDREDS[h])
    if (r < 10) stem = ORD_ONES[r]
    else if (r < 20) stem = ORD_TEENS[r - 10]
    else if (r % 10 === 0) stem = ORD_TENS[r / 10]
    else { head.push(TENS[Math.floor(r / 10)]); stem = ORD_ONES[r % 10] }
  }
  const end = stem === 'трет' ? (ending === 'е' ? 'ье' : 'ьего') : ending === 'е' ? 'ое' : ending
  return [...head, stem + end].join(' ')
}

/** 2026 → "две тысячи двадцать шестого", 2000 → "двухтысячного" (years 1000–2999). */
function yearWords(y: number): string {
  const th = Math.floor(y / 1000), rest = y % 1000
  if (!rest) return th === 1 ? 'тысячного' : 'двухтысячного'
  return `${th === 1 ? 'тысяча' : 'две тысячи'} ${ordinal(rest, 'ого')}`
}

/** 29.10.2026 → "двадцать девятое октября две тысячи двадцать шестого года"; null if not a date. */
export function dateWords(d: number, m: number, y?: number): string | null {
  if (d < 1 || d > 31 || m < 1 || m > 12 || (y != null && (y < 1000 || y > 2999))) return null
  return `${ordinal(d, 'е')} ${MONTHS[m - 1]}${y != null ? ` ${yearWords(y)} года` : ''}`
}

const LETTERS: Record<string, string> = {
  a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч', i: 'ай', j: 'джей', k: 'кей', l: 'эл', m: 'эм',
  n: 'эн', o: 'оу', p: 'пи', q: 'кью', r: 'ар', s: 'эс', t: 'ти', u: 'ю', v: 'ви', w: 'дабл-ю', x: 'экс', y: 'уай', z: 'зед',
}

/** Common words of this bot's world, read the way people say them. */
const WORDS: Record<string, string> = {
  claude: 'клод', code: 'код', anthropic: 'антропик', opus: 'опус', sonnet: 'сонет', haiku: 'хайку', fable: 'фейбл', mythos: 'мифос',
  telegram: 'телеграм', github: 'гитхаб', gitlab: 'гитлаб', git: 'гит', tmux: 'ти-макс', bot: 'бот', bun: 'бан', node: 'ноуд',
  python: 'пайтон', docker: 'докер', linux: 'линукс', ubuntu: 'убунту', whisper: 'виспер', silero: 'силеро', piper: 'пайпер',
  ok: 'окей', okay: 'окей', google: 'гугл', apple: 'эппл', iphone: 'айфон', android: 'андроид', windows: 'виндоус', macos: 'мак о эс',
  wifi: 'вай-фай', email: 'имейл', readme: 'ридми', main: 'мейн', develop: 'девелоп', branch: 'бранч', commit: 'коммит',
  merge: 'мёрдж', push: 'пуш', pull: 'пул', request: 'реквест', deploy: 'деплой', release: 'релиз', server: 'сервер',
  client: 'клиент', daemon: 'демон', session: 'сешн', sessions: 'сешнс', token: 'токен', tokens: 'токены', test: 'тест',
  tests: 'тесты', cloud: 'клауд', max: 'макс', pro: 'про', plugin: 'плагин', menu: 'меню', usage: 'юсэдж', help: 'хелп',
  topics: 'топики', topic: 'топик', chat: 'чат', chatgpt: 'чат джи-пи-ти', openai: 'оупен эй-ай', bewitched: 'бевичт',
  turbo: 'турбо', large: 'лардж', small: 'смол', medium: 'медиум', online: 'онлайн', offline: 'офлайн', bug: 'баг',
  feature: 'фича', fix: 'фикс', log: 'лог', logs: 'логи', hook: 'хук', hooks: 'хуки', prompt: 'промпт', model: 'модель',
  file: 'файл', files: 'файлы', link: 'линк', status: 'статус', ready: 'реди', done: 'дан', error: 'эррор', voice: 'войс',
  api: 'эй-пи-ай', mcp: 'эм-си-пи', cpu: 'си-пи-ю', gpu: 'джи-пи-ю', pr: 'пи-ар', id: 'ай-ди', url: 'ю-ар-эл', json: 'джейсон',
  http: 'эйч-ти-ти-пи', https: 'эйч-ти-ти-пи-эс', tts: 'ти-ти-эс', stt: 'эс-ти-ти', ai: 'эй-ай', ssh: 'эс-эс-эйч', sql: 'эс-кью-эл',
  notes: 'ноутс', hello: 'хеллоу', world: 'ворлд',
}

/** Rough English reading in Cyrillic for words outside the dictionary. */
function transliterate(word: string): string {
  let w = word.toLowerCase()
  if (w.length > 3 && w.endsWith('e') && !/[aeiouy]e$/.test(w)) w = w.slice(0, -1)
  const rules: [RegExp, string][] = [
    [/tion/g, 'шн'], [/sh/g, 'ш'], [/ch/g, 'ч'], [/th/g, 'т'], [/ph/g, 'ф'], [/ck/g, 'к'], [/qu/g, 'кв'], [/oo/g, 'у'],
    [/ee/g, 'и'], [/ea/g, 'и'], [/ou/g, 'ау'], [/ow/g, 'оу'], [/ai/g, 'ей'], [/ay/g, 'ей'], [/oa/g, 'оу'], [/wh/g, 'в'],
    [/c(?=[eiy])/g, 'с'], [/^y/g, 'й'], [/y/g, 'и'], [/x/g, 'кс'], [/j/g, 'дж'],
  ]
  for (const [re, to] of rules) w = w.replace(re, to)
  const single: Record<string, string> = {
    a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
    q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', z: 'з',
  }
  return w.replace(/[a-z]/g, c => single[c] ?? '')
}

function latinWord(word: string): string {
  const known = WORDS[word.toLowerCase()]
  if (known) return known
  // Abbreviations: PR, CPU, API, MCP — letter by letter.
  if (/^[A-Z]{2,5}s?$/.test(word) || word.length === 1) return word.replace(/s$/, '').toLowerCase().split('').map(c => LETTERS[c] ?? c).join('-')
  // camelCase / PascalCase: read the parts.
  const parts = word.split(/(?<=[a-z])(?=[A-Z])/)
  if (parts.length > 1) return parts.map(latinWord).join(' ')
  return transliterate(word)
}

/** Digits and Latin → what a Russian voice can read. */
export function normalizeForSpeech(text: string): string {
  return text
    // v3, 4o, gpt5: letters and digits glued together are read apart
    .replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    // 23:16 → двадцать три шестнадцать; 09:05 → девять ноль пять
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h: string, m: string) => `${numberWords(Number(h))} ${m === '00' ? 'ноль-ноль' : m.startsWith('0') ? `ноль ${numberWords(Number(m))}` : numberWords(Number(m))}`)
    // 29.10.2026 / 29.10 → двадцать девятое октября (две тысячи двадцать шестого года)
    .replace(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b(?!\.\d)/g, (all: string, dd: string, mm: string, yy?: string) => (yy || dd.length === 2 && mm.length === 2) ? dateWords(Number(dd), Number(mm), yy ? Number(yy) : undefined) ?? all : all)
    // 1.1.1 → один точка один точка один
    .replace(/\b\d+(?:\.\d+){2,}\b/g, v => v.split('.').map(x => numberWords(Number(x))).join(' точка '))
    // 41% / 3.5%
    .replace(/(\d+)(?:[.,](\d+))?\s?%/g, (_, i: string, f?: string) => f ? `${decimalWords(i, f)} процента` : `${numberWords(Number(i))} ${plural(Number(i), 'процент', 'процента', 'процентов')}`)
    // #38 → номер тридцать восемь
    .replace(/#(\d+)/g, (_, n: string) => `номер ${numberWords(Number(n))}`)
    // 3.5 / 3,5
    .replace(/\b(\d+)[.,](\d+)\b/g, (_, i: string, f: string) => decimalWords(i, f))
    // 1 600 / 12000 → words
    .replace(/\b\d{1,3}(?: \d{3})+\b|\b\d+\b/g, n => numberWords(Number(n.replace(/ /g, ''))))
    // Latin words (with digits glued on, like v4, already turned into words above)
    .replace(/[A-Za-z]+(?:'[a-z]+)?/g, latinWord)
    .replace(/[_/\\]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
