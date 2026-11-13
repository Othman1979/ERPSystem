/**
 * Minimal types for the parts of pdfmake 0.3 and fontkit 2 the printing
 * module uses (neither ships TypeScript types).
 */
declare module 'pdfmake' {
  interface OutputDocument {
    getBuffer(): Promise<Uint8Array>;
  }
  interface PdfMake {
    setFonts(fonts: Record<string, Record<'normal' | 'bold' | 'italics' | 'bolditalics', string | Buffer>>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(definition: object, options?: object): OutputDocument;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}

declare module 'fontkit' {
  export interface Font {
    unitsPerEm: number;
    layout(text: string): { advanceWidth: number; glyphs: { id: number; codePoints: number[] }[] };
  }
  export function openSync(path: string): Font;
  export function create(buffer: Buffer): Font;
}
