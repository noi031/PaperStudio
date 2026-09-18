// P3 PDF 服务：读取已下载 PDF 字节供渲染进程；必要时先按 pdf_url 下载。
import fs from 'node:fs';
import path from 'node:path';
import type { PaperRecord } from '../shared/types.js';
import {
  downloadPdf,
  isPdfFile,
  safeFileNameFromUrl,
  type DownloadProgress,
} from './searchService.js';

export interface PdfReadResult {
  title: string;
  data: Uint8Array;
  pdfPath: string;
}

export interface PdfEnsureOptions {
  /** 下载进度回调（源站限速时整篇可能耗时数分钟，调用方据此上报进度）。 */
  onProgress?: (progress: DownloadProgress) => void;
  /** 外部取消信号（用户停止下载时 abort）。 */
  signal?: AbortSignal;
  /** 强制重新下载（跳过本地已存在文件的复用），用于「重新下载」。 */
  force?: boolean;
}

export class PdfService {
  constructor(private readonly storageDir: string) {}

  /** 确保 PDF 已落到本地，返回绝对路径；已存在的有效 PDF 直接复用（除非 force）。 */
  async ensureDownloaded(paper: PaperRecord, options: PdfEnsureOptions = {}): Promise<string> {
    // 早先失败的“下载”可能把网关错误页当 PDF 存盘，这里按文件头校验，
    // 否则坏文件会被一直复用（阅读器直接报错）。
    if (!options.force && paper.pdfPath && isPdfFile(paper.pdfPath)) return paper.pdfPath;
    if (!paper.pdfUrl) throw new Error('该论文无可用 PDF 链接');
    const name = safeFileNameFromUrl(paper.pdfUrl) || paper.externalId || paper.id;
    return downloadPdf(paper.pdfUrl, this.storageDir, name, {
      onProgress: options.onProgress,
      signal: options.signal,
    });
  }

  /** 读取论文 PDF：无有效本地文件时按 pdf_url 下载到存储目录后读取。返回实际文件路径。 */
  async ensureAndRead(paper: PaperRecord, options: PdfEnsureOptions = {}): Promise<PdfReadResult> {
    const pdfPath = await this.ensureDownloaded(paper, options);
    const buf = fs.readFileSync(pdfPath);
    return { title: paper.title, data: new Uint8Array(buf), pdfPath };
  }
}

export function resolveStorageDir(configured: string, userDataDir: string): string {
  if (configured) return configured;
  return path.join(userDataDir, 'papers');
}
