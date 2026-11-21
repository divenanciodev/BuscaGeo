const fs = require('fs/promises');
const path = require('path');
const { parseOffice } = require('officeparser');

const TEXT_EXTENSIONS = new Set(['.txt', '.csv', '.xml']);
const OFFICE_EXTENSIONS = new Set(['.pdf', '.docx', '.odt', '.xlsx', '.xlsm', '.ods', '.rtf']);
const DOCUMENT_TEXT_EXTENSIONS = [...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS];
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 100000;

function supportsDocumentText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension);
}

function cleanText(text) {
  return String(text || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARACTERS);
}

async function extractDocumentText(filePath) {
  if (!supportsDocumentText(filePath)) return '';

  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) throw new Error('Arquivo acima do limite de 15 MB');

  const extension = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = await fs.readFile(filePath, 'utf8');
    return cleanText(text.replace(/<[^>]*>/g, ' '));
  }

  const document = await parseOffice(filePath, {
    pdfParserConfig: {
      extractTextColor: false,
      maxTextItems: 10000,
      maxTimeMs: 3000,
      processMemoryMb: 512
    }
  });
  const result = await document.to('text', {
    includeImages: false,
    textConfig: { preserveLayout: false, renderNotes: false }
  });
  return cleanText(result.value);
}

module.exports = { DOCUMENT_TEXT_EXTENSIONS, extractDocumentText, supportsDocumentText };
