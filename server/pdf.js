import { PDFParse } from 'pdf-parse';

/** @typedef {{id: string, page: number, clause: string|null, text: string}} Paragraph */

const CLAUSE_START = /^(\d+\.\d+(?:\.\d+)*|\d+\.)\s+[A-Z("“]/;
const HEADING = /^[A-Z][A-Z0-9 \-&,'’:/().]{3,80}$/;
const PAGE_FOOTER = /^--\s*\d+\s+of\s+\d+\s*--$/i;

export async function pdfPageTexts(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const res = await parser.getText();
    return res.pages.map((p) => ({ page: p.num, text: p.text }));
  } finally {
    await parser.destroy();
  }
}

function chunkLong(text, max = 900) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+["”')\]]*\s*|[^.!?]+$/g) || [text];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > max) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Split per-page text into paragraphs. New paragraph on a numbered clause ("4.2 ..."), on an
 * ALL-CAPS heading line, or on a blank line. Overlong paragraphs are chunked at sentence
 * boundaries so citations stay pinpoint. IDs are `P<page>.<n>` in reading order.
 * @returns {Paragraph[]}
 */
export function splitParagraphs(pages) {
  const out = [];
  for (const { page, text } of pages) {
    const blocks = [];
    let cur = [];
    const flush = () => { if (cur.length) blocks.push(cur.join(' ').replace(/\s+/g, ' ').trim()); cur = []; };
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (PAGE_FOOTER.test(line)) continue;
      if (!line) { flush(); continue; }
      if (CLAUSE_START.test(line) || HEADING.test(line)) flush();
      cur.push(line);
      if (HEADING.test(line)) flush();
    }
    flush();
    let n = 0;
    for (const b of blocks) {
      if (b.length < 3) continue;
      for (const piece of chunkLong(b)) {
        n += 1;
        const m = piece.match(/^(\d+\.\d+(?:\.\d+)*|\d+\.)\s/);
        out.push({ id: `P${page}.${n}`, page, clause: m ? m[1].replace(/\.$/, '') : null, text: piece });
      }
    }
  }
  return out;
}

/** True if the PDF has a usable text layer (i.e. is not a scan). */
export const hasTextLayer = (pages) => pages.reduce((n, p) => n + p.text.trim().length, 0) > 200;

/** Human-readable citation label for a paragraph. */
export const refLabel = (p) => `Page ${p.page}, ¶${p.id.split('.')[1]}${p.clause ? ` (§${p.clause})` : ''}`;
