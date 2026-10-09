/** Read the first worksheet of an .xlsx file into a grid of strings. */

function xmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripPrefixes(xml: string): string {
  return xml.replace(/<(\/?)[a-zA-Z0-9]+:/g, '<$1');
}

function findEocd(buf: Uint8Array): number {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      return i;
    }
  }
  throw new Error('This file is not a readable .xlsx spreadsheet.');
}

type ZipEntry = {
  method: number;
  compSize: number;
  localOffset: number;
  name: string;
};

function readCentralDirectory(buf: Uint8Array): ZipEntry[] {
  const eocd = findEocd(buf);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('This file is not a readable .xlsx spreadsheet.');
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(buf.subarray(offset + 46, offset + 46 + nameLen));
    entries.push({ method, compSize, localOffset, name });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  const stream = new Blob([copy]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

async function readEntry(buf: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const local = entry.localOffset;
  if (view.getUint32(local, true) !== 0x04034b50) {
    throw new Error('This file is not a readable .xlsx spreadsheet.');
  }
  const nameLen = view.getUint16(local + 26, true);
  const extraLen = view.getUint16(local + 28, true);
  const start = local + 30 + nameLen + extraLen;
  const compressed = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRaw(compressed);
  throw new Error('This spreadsheet uses a compression format that could not be read.');
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const inner = match[1]
      .replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
      .replace(/<phoneticPr\b[^>]*\/>/g, '');
    const texts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) =>
      xmlText(t[1]),
    );
    out.push(texts.join(''));
  }
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= '0' && ch <= '9') break;
    n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  }
  return n - 1;
}

function rowIndex(ref: string): number {
  const digits = ref.replace(/^[A-Za-z]+/, '');
  return Number(digits) || 0;
}

function sheetGrid(xml: string, strings: string[]): string[][] {
  const rows = new Map<number, Map<number, string>>();
  let maxRow = 0;
  let maxCol = 0;
  const re = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const attrs = match[1];
    const inner = match[2] ?? '';
    const ref = /(?:^|\s)r="([^"]+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const row = rowIndex(ref);
    const col = columnIndex(ref);
    if (row <= 0 || col < 0) continue;
    const type = /(?:^|\s)t="([^"]+)"/.exec(attrs)?.[1] ?? '';
    let value = '';
    if (type === 'inlineStr') {
      value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((t) => xmlText(t[1]))
        .join('');
    } else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
      if (type === 's') value = strings[Number(raw)] ?? '';
      else value = xmlText(raw);
    }
    const line = rows.get(row) ?? new Map<number, string>();
    line.set(col, value);
    rows.set(row, line);
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  }

  const grid: string[][] = [];
  for (let r = 1; r <= maxRow; r++) {
    const line = rows.get(r);
    if (!line) continue;
    const cells: string[] = [];
    for (let c = 0; c <= maxCol; c++) cells.push(line.get(c) ?? '');
    if (cells.some((cell) => cell.trim() !== '')) grid.push(cells);
  }
  return grid;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)(?:[A-Za-z0-9]+:)?${name}="([^"]*)"`);
  return re.exec(tag)?.[1] ?? null;
}

export async function parseXlsx(buffer: ArrayBuffer): Promise<string[][]> {
  const buf = new Uint8Array(buffer);
  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((entry) => [entry.name.replace(/^\/+/, ''), entry]));

  const readXml = async (name: string) => {
    const entry = byName.get(name);
    if (!entry) return '';
    const bytes = await readEntry(buf, entry);
    return stripPrefixes(new TextDecoder().decode(bytes));
  };

  const workbook = await readXml('xl/workbook.xml');
  const rels = await readXml('xl/_rels/workbook.xml.rels');
  const sheetTag = /<sheet\b[^>]*\/?>/.exec(workbook)?.[0];
  if (!sheetTag) throw new Error('No worksheet found in this spreadsheet.');
  const relId = attr(sheetTag, 'id');
  const relTag = relId
    ? new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*\\/?>`).exec(rels)?.[0]
    : null;
  let target = relTag ? attr(relTag, 'Target') : null;
  if (!target) target = 'worksheets/sheet1.xml';
  target = target.replace(/^\/?xl\//, '');
  const sheet = await readXml(`xl/${target}`);
  if (!sheet) throw new Error('No worksheet found in this spreadsheet.');
  const stringsXml = await readXml('xl/sharedStrings.xml');
  return sheetGrid(sheet, stringsXml ? sharedStrings(stringsXml) : []);
}
