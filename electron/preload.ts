// 预加载脚本：暴露类型安全的 IPC 桥（window.paper）。
import { contextBridge, ipcRenderer, webUtils } from 'electron';

type IpcContractShape = import('../src/shared/types').IpcContract;

const call = <K extends keyof IpcContractShape>(
  channel: K,
  req: IpcContractShape[K]['req'],
): Promise<IpcContractShape[K]['res']> => ipcRenderer.invoke(channel as string, req);

contextBridge.exposeInMainWorld('paper', {
  call,
  invoke: (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload),
  // 取本地文件的绝对路径（File.path 在新版 Electron 已移除，改用 webUtils）。
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    // 与 Web 版对齐：Electron 下文件本就在本机，直接返回绝对路径，无需上传。
    uploadFile: async (file: File) => webUtils.getPathForFile(file),
  onAgentEvent: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('agent:event', wrapped);
    return () => ipcRenderer.removeListener('agent:event', wrapped);
  },
  onSummaryEvent: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('summary:event', wrapped);
    return () => ipcRenderer.removeListener('summary:event', wrapped);
  },
  onSearchEvent: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('search:event', wrapped);
    return () => ipcRenderer.removeListener('search:event', wrapped);
  },
  onPapersEvent: (listener: (payload: unknown) => void) => {
    const wrapped = (_e: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on('papers:event', wrapped);
    return () => ipcRenderer.removeListener('papers:event', wrapped);
  },
});
