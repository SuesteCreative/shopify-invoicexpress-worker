/**
 * What a wall attachment is allowed to be, decided by READING the file.
 *
 * A browser decides what to do with a response from its content type, and the
 * content type a browser SENDS on an upload is whatever the client claimed. So
 * the claim is ignored: every file is identified by its leading bytes, and what
 * we store is what we recognised, never what we were told.
 *
 * The one that matters is SVG, and it is refused outright. An SVG is an XML
 * document that can carry <script>, so serving one from the admin's own origin
 * hands a visitor's session to whoever uploaded it. It looks like an image in
 * every listing and is not one.
 *
 * Zero imports: this is shared by an edge route and a client component.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_POST = 5;

export interface FileKind {
  contentType: string;
  /** Safe to render in place. Only real raster images are. */
  inline: boolean;
  ext: string;
}

/**
 * `exts` is not decoration: the bytes and the name have to agree.
 *
 * Not only for images. A PDF uploaded as `inocente.png` is served back with a
 * PDF content type under a name that says image, and a listing that trusts the
 * name shows it as one. Refusing the disagreement is cheaper than reasoning
 * about which half to believe.
 */
const BYTES: Array<{ sig: number[]; at: number; exts: string[]; kind: FileKind }> = [
  { sig: [0x89, 0x50, 0x4e, 0x47], at: 0, exts: ["png"], kind: { contentType: "image/png", inline: true, ext: "png" } },
  { sig: [0xff, 0xd8, 0xff], at: 0, exts: ["jpg", "jpeg"], kind: { contentType: "image/jpeg", inline: true, ext: "jpg" } },
  { sig: [0x47, 0x49, 0x46, 0x38], at: 0, exts: ["gif"], kind: { contentType: "image/gif", inline: true, ext: "gif" } },
  { sig: [0x25, 0x50, 0x44, 0x46], at: 0, exts: ["pdf"], kind: { contentType: "application/pdf", inline: false, ext: "pdf" } },
];

const startsWith = (b: Uint8Array, sig: number[], at: number) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** WEBP is RIFF....WEBP — the tag is at byte 8, not byte 0. */
const isWebp = (b: Uint8Array) =>
  startsWith(b, [0x52, 0x49, 0x46, 0x46], 0) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);

/** XLSX is a zip. So is a lot else, which is why the extension has to agree. */
const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04], 0);

/** Legacy .xls, the OLE2 compound document. */
const isOle2 = (b: Uint8Array) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);

const extOf = (filename: string) => (filename.split(".").pop() ?? "").toLowerCase();

/**
 * Text has no signature, so it is recognised by exclusion: valid UTF-8, no NUL
 * bytes, and an extension that says text. A spreadsheet program is what turns a
 * CSV into something dangerous (a leading `=` is a formula), and that is the
 * reader's decision on a file we always hand over as a download.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, 4096));
    return true;
  } catch {
    return false;
  }
}

/**
 * What this file actually is, or null to refuse it.
 *
 * `bytes` need only be the first few KB; nothing here reads further.
 */
export function identifyFile(filename: string, bytes: Uint8Array): FileKind | null {
  const ext = extOf(filename);

  // Refused before anything else, and by extension as well as by content: an SVG
  // has no magic number and would otherwise pass the text check below.
  if (ext === "svg" || ext === "svgz" || ext === "html" || ext === "htm" || ext === "xhtml") return null;

  for (const { sig, at, exts, kind } of BYTES) {
    if (startsWith(bytes, sig, at)) {
      return exts.includes(ext) ? kind : null;
    }
  }

  if (isWebp(bytes) && ["webp"].includes(ext)) {
    return { contentType: "image/webp", inline: true, ext: "webp" };
  }

  if (isZip(bytes) && ext === "xlsx") {
    return { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false, ext: "xlsx" };
  }

  if (isOle2(bytes) && ext === "xls") {
    return { contentType: "application/vnd.ms-excel", inline: false, ext: "xls" };
  }

  if ((ext === "csv" || ext === "txt" || ext === "tsv") && looksLikeText(bytes)) {
    return { contentType: "text/plain", inline: false, ext };
  }

  return null;
}

/** Strips anything a filename could smuggle into a path or a header. */
export function safeFilename(name: string): string {
  return (name.split(/[\\/]/).pop() ?? "ficheiro")
    .replace(/[\u0000-\u001f\u007f"\\]/g, "")
    .trim()
    .slice(0, 120) || "ficheiro";
}
