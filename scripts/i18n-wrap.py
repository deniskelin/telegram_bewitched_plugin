#!/usr/bin/env python3
"""
One-off helper for the i18n migration: wraps Russian string literals of a
TypeScript file in a translation call.

  'Текст'                    -> t('Текст')
  `Сессия #${s.id} закрыта`  -> t('Сессия #{id} закрыта', { id: s.id })

Literals already inside t(/tr(/k(, in comments, and on lines marked
"i18n-ignore" (or the line after) are left alone. Review the diff: logic
strings (comparisons, parsing) must not be wrapped.

  python3 scripts/i18n-wrap.py <file.ts> [fn=t]
"""

import re
import sys

CYR = re.compile(r'[А-Яа-яЁё]')


def scan_template(src, i):
    """src[i] == '`'. Returns (end index after closing `, parts) with parts = [('s', text) | ('e', expr)]."""
    parts, buf, j = [], [], i + 1
    while j < len(src):
        c = src[j]
        if c == '\\':
            buf.append(src[j:j + 2]); j += 2; continue
        if c == '`':
            parts.append(('s', ''.join(buf)))
            return j + 1, parts
        if c == '$' and src[j + 1:j + 2] == '{':
            parts.append(('s', ''.join(buf))); buf = []
            k, depth = j + 2, 1
            while depth:
                ch = src[k]
                if ch == '`':
                    k, _ = scan_template(src, k); continue
                if ch in '\'"':
                    k = scan_quoted(src, k); continue
                if ch == '{': depth += 1
                elif ch == '}': depth -= 1
                k += 1
            parts.append(('e', src[j + 2:k - 1]))
            j = k
            continue
        buf.append(c); j += 1
    raise ValueError('unterminated template')


def scan_quoted(src, i):
    q, j = src[i], i + 1
    while src[j] != q:
        j += 2 if src[j] == '\\' else 1
    return j + 1


def quote(text):
    # template text -> single-quoted JS string (escapes kept, real newlines escaped)
    text = text.replace('\\`', '`').replace('\\$', '$')
    text = re.sub(r"(?<!\\)'", "\\'", text)
    return "'" + text.replace('\n', '\\n') + "'"


def name_for(expr, used):
    e = expr.strip()
    m = re.fullmatch(r'[\w$.!?]+', e)
    base = re.sub(r'\W', '', e.split('.')[-1]) if m else ''
    if not base or base[0].isdigit():
        base = 'v'
    n, k = base, 2
    while n in used and used[n] != e:
        n, k = f'{base}{k}', k + 1
    used[n] = e
    return n


def convert(src, fn):
    out, i, n = [], 0, len(src)
    lines_ignored = set()
    for no, line in enumerate(src.split('\n')):
        if 'i18n-ignore' in line:
            lines_ignored.update({no, no + 1})
    line_starts = [0]
    for m in re.finditer('\n', src):
        line_starts.append(m.end())

    def line_of(pos):
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= pos: lo = mid
            else: hi = mid - 1
        return lo

    def preceded_by_call(pos):
        before = ''.join(out)[-8:]
        return re.search(r'(?<![\w.])(?:tr|t|k)\(\s*$', before) is not None

    while i < n:
        c = src[i]
        if src.startswith('//', i):
            j = src.find('\n', i); j = n if j < 0 else j
            out.append(src[i:j]); i = j; continue
        if src.startswith('/*', i):
            j = src.find('*/', i) + 2
            out.append(src[i:j]); i = j; continue
        if c == '/' and re.search(r'[(,=:!&|?;{}\[]\s*$|return\s*$|^\s*$', ''.join(out)[-20:]):
            # regex literal
            j = i + 1; cls = False
            while j < n and (src[j] != '/' or cls):
                if src[j] == '\\': j += 1
                elif src[j] == '[': cls = True
                elif src[j] == ']': cls = False
                j += 1
            j += 1
            while j < n and src[j].isalpha(): j += 1
            out.append(src[i:j]); i = j; continue
        if c in '\'"':
            j = scan_quoted(src, i)
            lit = src[i:j]
            if CYR.search(lit) and line_of(i) not in lines_ignored and not preceded_by_call(i):
                if c == '"':
                    lit = quote(lit[1:-1].replace("\\'", "'"))
                out.append(f'{fn}({lit})')
            else:
                out.append(lit)
            i = j; continue
        if c == '`':
            j, parts = scan_template(src, i)
            raw = src[i:j]
            statics = ''.join(p[1] for p in parts if p[0] == 's')
            if CYR.search(statics) and line_of(i) not in lines_ignored and not preceded_by_call(i):
                used, text, vars_ = {}, [], []
                for kind, val in parts:
                    if kind == 's':
                        text.append(val)
                    else:
                        inner = convert(val, fn) if '`' in val or CYR.search(val) else val
                        nm = name_for(val, used)
                        if (nm, inner.strip()) not in vars_: vars_.append((nm, inner.strip()))
                        text.append('{' + nm + '}')
                q = quote(''.join(text))
                if vars_:
                    obj = ', '.join(nm if nm == e else f'{nm}: {e}' for nm, e in vars_)
                    out.append(f'{fn}({q}, {{ {obj} }})')
                else:
                    out.append(f'{fn}({q})')
            else:
                # convert Russian templates nested in expressions
                rebuilt = ['`']
                for kind, val in parts:
                    rebuilt.append(val if kind == 's' else '${' + (convert(val, fn) if '`' in val or CYR.search(val) else val) + '}')
                rebuilt.append('`')
                out.append(''.join(rebuilt))
            i = j; continue
        out.append(c); i += 1
    return ''.join(out)


if __name__ == '__main__':
    path = sys.argv[1]
    fn = sys.argv[2] if len(sys.argv) > 2 else 't'
    src = open(path).read()
    out = convert(src, fn)
    open(path, "w").write(out)
