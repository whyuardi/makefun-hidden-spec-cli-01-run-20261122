// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text files, finding the
// lines an edit names at the first of three matching tiers, and changing every file or none. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- SPEC.md section 3: a file as its lines, its line break and its final break ----

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- SPEC.md section 5: matching lines at three tiers ----

function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

function trimTrail(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return s.slice(0, i);
}

function trimBoth(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a++;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return s.slice(a, b);
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  ctx: boolean;
  oIdx: number;
  text: string;
}

/** A new line of N, re-indented at tier 2 (section 5). */
function reindent(text: string, tier: number, firstFileLine: string, firstOldLine: string): string {
  if (tier !== 2) return text;
  if (text === '' || text.trim() === '') return text;
  const f = leadingWs(firstFileLine);
  const p = leadingWs(firstOldLine);
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** The lines N writes: context lines as the file's own matched lines, the rest re-indented. */
function buildN(n: NLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    return reindent(e.text, tier, fileLines[pos]!, o[0]!);
  });
}

/** A hunk or chunk body line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
}

/** Split a body into its old lines O and its new lines N. */
function splitON(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ ctx: true, oIdx: o.length - 1, text: b.text });
    } else if (b.kind === 'old') o.push(b.text);
    else if (b.kind === 'new') n.push({ ctx: false, oIdx: -1, text: b.text });
  }
  return { o, n };
}

/** True when a `\` line follows the body's last context or `+` line. */
function bodyNoNewline(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'backslash';
}

// ---- SPEC.md section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
  noNewline: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  oldDiff: string | null;
  newDiff: string | null;
  create: boolean;
  del: boolean;
  hasPaths: boolean;
  hunks: Hunk[];
}

/** A `--- `/`+++ ` path: up to the first tab, surrounding spaces removed, one `a/`/`b/` removed. */
function diffPath(s: string): string | null {
  let p = s.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: null,
        newPath: null,
        renameFrom: null,
        renameTo: null,
        oldDiff: m[1]!,
        newDiff: m[2]!,
        create: false,
        del: false,
        hasPaths: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(l.slice(4));
      const newP = diffPath(lines[i + 1]!.slice(4));
      if (cur === null || !inHeader || cur.hasPaths) {
        cur = {
          oldPath: oldP,
          newPath: newP,
          renameFrom: null,
          renameTo: null,
          oldDiff: null,
          newDiff: null,
          create: false,
          del: false,
          hasPaths: true,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPaths = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: b.slice(1) });
          i++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'backslash', text: b.slice(1) });
          i++;
          continue;
        }
        break;
      }
      const noNewline = bodyNoNewline(body);
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body, noNewline });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const fs = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitON(h.body);
    if (o.length > 0) {
      const m = findMatch(fs.lines, o, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of m.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const touchesEnd = pos + o.length === fs.lines.length;
      const rep = buildN(n, fs.lines, pos, o, m.tier);
      fs.lines.splice(pos, o.length, ...rep);
      if (touchesEnd) fs.final = !h.noNewline;
      d += n.length - o.length;
    } else {
      const idx = Math.max(0, Math.min(h.a + d, fs.lines.length));
      const atEnd = idx === fs.lines.length;
      const rep = n.map((e) => e.text);
      fs.lines.splice(idx, 0, ...rep);
      if (atEnd) fs.final = !h.noNewline;
      d += n.length;
    }
  }
  return renderFile(fs);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree) => {
    const oldP = s.oldPath ?? s.renameFrom ?? s.oldDiff;
    const newP = s.newPath ?? s.renameTo ?? s.newDiff;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || s.create;
    const isDelete = !isCreate && (newP === null || s.del);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let noNl = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        for (let bi = h.body.length - 1; bi >= 0; bi--) {
          if (h.body[bi]!.kind === 'new') {
            noNl = h.body[bi + 1] !== undefined && h.body[bi + 1]!.kind === 'backslash';
            break outer;
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    if (op !== np) {
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const rendered = applyHunks(before, s.hunks, strict, op);
      tree.now.set(np, rendered);
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(before, s.hunks, strict, op));
  });
}

// ---- SPEC.md section 7: SEARCH/REPLACE blocks ----

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSr(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        const tr = t.trim();
        if (tr.startsWith('```')) continue;
        path = tr;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSr(lines);
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const fs = parseFile(before);
    const m = findMatch(fs.lines, b.old, strict);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = m.positions[0]!;
    const rep = b.nw.map((t) => reindent(t, m.tier, fs.lines[pos]!, b.old[0]!));
    fs.lines.splice(pos, b.old.length, ...rep);
    tree.now.set(b.path, renderFile(fs));
  });
}

// ---- SPEC.md section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
  updateLine: number;
}

/** Drop trailing empty context lines from a chunk (blank lines at the end of a section). */
function trimChunk(c: V4aChunk): void {
  while (c.body.length > 0 && c.body[c.body.length - 1]!.kind === 'ctx' && c.body[c.body.length - 1]!.text === '') c.body.pop();
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let chunk: V4aChunk | null = null;
  let chunkClosed = false;
  const closeSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    }
    if (cur.kind === 'update') {
      if (chunk !== null) {
        trimChunk(chunk);
        cur.chunks.push(chunk);
        chunk = null;
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.updateLine}`);
    }
    cur = null;
    chunk = null;
    chunkClosed = false;
  };
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const isAdd = l.startsWith('*** Add File: ');
    const isDel = l.startsWith('*** Delete File: ');
    const isUpd = l.startsWith('*** Update File: ');
    if (isAdd || isDel || isUpd) {
      closeSection();
      const marker = isAdd ? '*** Add File:' : isDel ? '*** Delete File:' : '*** Update File:';
      cur = {
        kind: isAdd ? 'add' : isDel ? 'delete' : 'update',
        path: l.slice(marker.length).trim(),
        lines: [],
        moveTo: null,
        chunks: [],
        updateLine: i + 1,
      };
      sections.push(cur);
      chunk = null;
      chunkClosed = false;
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (l === '') {
        cur.lines.push('');
        continue;
      }
      if (l.startsWith('+')) {
        cur.lines.push(l.slice(1));
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (l.startsWith('*** Move to: ')) {
      if (chunk !== null || chunkClosed || cur.moveTo !== null || cur.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      if (chunk !== null) {
        cur.chunks.push(chunk);
      }
      chunk = { anchor: l.slice(2).trim(), body: [], eof: false };
      chunkClosed = false;
      continue;
    }
    if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.chunks.push(chunk);
      chunk.eof = true;
      chunk = null;
      chunkClosed = true;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (chunkClosed) {
        if (blank(l)) continue;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunk === null) chunk = { anchor: null, body: [], eof: false };
      const kind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
      chunk.body.push({ kind, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((s) => (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const fs = parseFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const am = findMatch(fs.lines, [chunk.anchor], strict, cursor);
        if (am === null) throw new Fail('no-match', s.path);
        cursor = am.positions[0]! + 1;
      }
      const { o, n } = splitON(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? fs.lines.length : cursor;
        const rep = n.map((e) => e.text);
        fs.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else {
        const m = findMatch(fs.lines, o, strict, cursor);
        if (m === null) throw new Fail('no-match', s.path);
        let pos = -1;
        for (const p of m.positions) {
          if (chunk.eof && p + o.length !== fs.lines.length) continue;
          pos = p;
          break;
        }
        if (pos < 0) throw new Fail('no-match', s.path);
        const rep = buildN(n, fs.lines, pos, o, m.tier);
        fs.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const rendered = renderFile(fs);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, rendered);
      tree.now.set(s.path, null);
      tree.moves.push({ old: s.path, new: s.moveTo });
    } else {
      tree.now.set(s.path, rendered);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const items: { key: string; text: string }[] = [];
  {
    const newOfOld = new Map<string, string>();
    const oldOfNew = new Map<string, string>();
    for (const mv of tree.moves) {
      const wasOld = tree.original(mv.old);
      const nowOld = tree.get(mv.old);
      const wasNew = tree.original(mv.new);
      const nowNew = tree.get(mv.new);
      if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
        newOfOld.set(mv.old, mv.new);
        oldOfNew.set(mv.new, mv.old);
      }
    }
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (oldOfNew.has(p)) {
        items.push({ key: p, text: `R ${oldOfNew.get(p)!} -> ${p}` });
        continue;
      }
      if (newOfOld.has(p)) continue;
      items.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
    items.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  }
  const rows = items.map((it) => it.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
