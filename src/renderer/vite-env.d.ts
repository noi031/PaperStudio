// 渲染进程 CSS side-effect 导入（pdfjs pdf_viewer.css）类型声明。
declare module '*.css';

// pdfjs 官方 viewer 子路径（PDFViewer/EventBus/PDFLinkService）的轻量类型声明。
declare module 'pdfjs-dist/web/pdf_viewer' {
  export interface PdfPageViewLike {
    id: number;
    textLayer: { div: HTMLElement } | null;
  }
  export class EventBus {
    on(eventName: string, listener: (evt: unknown) => void): void;
    off(eventName: string, listener: (evt: unknown) => void): void;
  }
  export class PDFLinkService {
    constructor(opts: { eventBus: EventBus });
    setViewer(viewer: unknown): void;
  }
  export class PDFViewer {
    constructor(opts: {
      container: HTMLElement;
      viewer?: HTMLElement;
      eventBus: EventBus;
      linkService: PDFLinkService;
    });
    setDocument(doc: import('pdfjs-dist').PDFDocumentProxy): void;
    cleanup(): void;
    currentScale: number;
    currentPageNumber: number;
    pagesCount: number;
    getPageView(index: number): PdfPageViewLike | null;
  }
}
