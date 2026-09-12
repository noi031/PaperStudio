// P3 PDF 服务：读取已下载 PDF 字节供渲染进程；必要时先按 pdf_url 下载。
import fs from 'node:fs';
import path from 'node:path';
import type { PaperRecord } from '../shared/types.js';
import { downloadPdf, safeFileNameFromUrl } from './searchService.js';

export interface PdfReadResult {
  title: string;
  data: Uint8Array;
  pdfPath: string;
}

export class PdfService {
  constructor(private readonly storageDir: string) {}

  /** 读取论文 PDF：无 pdf_path 时按 pdf_url 下载到存储目录后读取。返回实际文件路径。 */
  async ensureAndRead(paper: PaperRecord): Promise<PdfReadResult> {
    let pdfPath = paper.pdfPath;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      if (!paper.pdfUrl) throw new Error('该论文无可用 PDF 链接');
      const name = safeFileNameFromUrl(paper.pdfUrl) || paper.externalId || paper.id;
      pdfPath = await downloadPdf(paper.pdfUrl, this.storageDir, name);
    }
    const buf = fs.readFileSync(pdfPath);
    return { title: paper.title, data: new Uint8Array(buf), pdfPath };
  }
}

export function resolveStorageDir(configured: string, userDataDir: string): string {
  if (configured) return configured;
  return path.join(userDataDir, 'papers');
}
