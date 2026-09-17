// AI 后端解析：PaperStudio 同一套应用代码可跑在两种后端之上。
//
//   dsh    本机 deepseek-harness 引擎（子进程 + stdio JSON-RPC + 论文域 MCP 工具），
//          本地部署的默认形态，LLM 凭证在设置页配置（OpenAI 兼容端点）。
//   echocap  Echo 平台能力网关（Unix Socket RPC：sub_agent.* / model.call.*），
//          模型与鉴权由平台提供，Web（Host）部署形态。
//
// 解析优先级（从高到低）：
//   1) 环境变量 PAPERSTUDIO_BACKEND=dsh|echocap（部署层强制指定）
//   2) 设置页 aiBackend（dsh | echocap；留空 = 自动）
//   3) 自动探测：EchoCap socket + 鉴权 key 可用 → echocap，否则 → dsh
//
// 消费方：
//   - createAgentHost() 在进程启动时选 AgentHost 实现（引擎会话宿主）
//   - llm.ts 每次调用时按当前 settings 选 LLM 通道（OpenAI 直连 / model.call）
import type { PaperSettings } from '../shared/types.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { echoCapStatus } from './echoCap.js';

export type BackendKind = 'dsh' | 'echocap';

export const BACKEND_ENV = 'PAPERSTUDIO_BACKEND';

/** 解析当前应使用的后端。getSettings 为惰性读取（进程启动早期 DB 可能尚未打开）。 */
export function resolveBackend(getSettings: () => PaperSettings): BackendKind {
  const fromEnv = process.env[BACKEND_ENV]?.trim().toLowerCase();
  if (fromEnv === 'dsh' || fromEnv === 'echocap') return fromEnv;
  const pref = getSettings().aiBackend;
  if (pref === 'dsh' || pref === 'echocap') return pref;
  // 自动：平台注入了 EchoCap 环境 → echocap；否则回退本机 dsh。
  return echoCapStatus().ok ? 'echocap' : 'dsh';
}

/** 后端的人类可读标签（健康检查/日志用）。 */
export function backendLabel(kind: BackendKind): string {
  return kind === 'echocap' ? 'EchoCap 代理' : 'dsh 引擎';
}

/** 无 settings 回调时的兜底（仅用于工厂等不需要真实配置的路径）。 */
export function defaultSettings(): PaperSettings {
  return DEFAULT_SETTINGS;
}
