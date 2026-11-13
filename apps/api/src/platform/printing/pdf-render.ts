import pdfmake from 'pdfmake';
import { fontBytes, FONT_NAME } from './fonts.js';

let configured = false;
function configurePdfmake() {
  if (configured) return;
  const { normal, bold } = fontBytes();
  // Buffers, not file paths: parsed from memory with nothing to decompress per document.
  pdfmake.setFonts({ [FONT_NAME]: { normal, bold, italics: normal, bolditalics: bold } });
  // Documents never fetch anything: no URLs, and no local files (the fonts are already in memory).
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  configured = true;
}

/** Renders a pdfmake document definition to PDF bytes. */
export async function renderPdf(definition: object): Promise<Buffer> {
  configurePdfmake();
  return Buffer.from(await pdfmake.createPdf(definition).getBuffer());
}
