// 渲染进程全局声明：window.paper 桥（由 webBridge.ts 安装，HTTP RPC + SSE）。
import type { IpcContract, PapersEvent, SummaryEvent } from '../shared/types';

declare global {
  interface Window {
    paper: {
      invoke: <K extends keyof IpcContract>(channel: K, req?: IpcContract[K]['req']) => Promise<IpcContract[K]['res']>;
        getPathForFile: (file: File) => string;
        /** 取得可用于服务端处理的文件路径：浏览器拿不到本地绝对路径，上传后返回服务端路径。 */
        uploadFile: (file: File) => Promise<string>;
      onAgentEvent: (listener: (payload: unknown) => void) => () => void;
      onSummaryEvent: (listener: (payload: SummaryEvent) => void) => () => void;
      onSearchEvent: (listener: (payload: { stage: 'plan' | 'searching' | 'scoring' }) => void) => () => void;
      /** PDF 后台下载的进度/结果事件（papers:event）。 */
      onPapersEvent: (listener: (payload: PapersEvent) => void) => () => void;
    };
  }
}

export {};
