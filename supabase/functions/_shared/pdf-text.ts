import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";

/** Plain text of every page, pages separated by blank lines. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // pdf.js takes ownership of (detaches) the buffer, so give it a copy.
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join("\n\n");
}
