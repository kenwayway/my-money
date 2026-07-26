import Papa from "papaparse";

export interface RawCsv {
  /** Raw lines exactly as in the file (BOM stripped), for AI sampling + fingerprinting. */
  lines: string[];
  /** Full text with BOM stripped and normalized newlines. */
  text: string;
}

export function readCsvText(buf: Buffer): RawCsv {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l, i, arr) => !(l === "" && i === arr.length - 1));
  return { lines, text };
}

/** Parse the full file into rows of string cells using the given delimiter. */
export function parseRows(text: string, delimiter: string): string[][] {
  const result = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: true,
  });
  return result.data;
}
