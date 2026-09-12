// 渲染进程全局声明：preload 暴露的 window.paper 桥。
import type { IpcContract, SummaryEvent } from '../shared/types';

declare global {
  interface Window {
    paper: {
      invoke: <K extends keyof IpcContract>(channel: K, req?: IpcContract[K]['req']) => Promise<IpcContract[K]['res']>;
      onAgentEvent: (listener: (payload: unknown) => void) => () => void;
      onSummaryEvent: (listener: (payload: SummaryEvent) => void) => () => void;
    };
  }
}

export {};
