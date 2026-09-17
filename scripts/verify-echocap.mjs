#!/usr/bin/env node
// EchoCap 的端到端验证（纯 Node，不依赖 GUI）。
//
// 验证内容：
//   1) EchoCap 端点可用（socket + 鉴权）
//   2) model.call 直连（总结/方向/写作/检索评估走的路径）
//   3) AgentHost 对话收发：sendMessage → sections 轮询 → AgentEvent 归一化
//   4) 渲染层产物不含 CAP 凭证
//
// 用法：npm run build:host && node scripts/verify-echocap.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = (p) => require(path.join(root, 'dist-host/src/main', p));

const { EchoCapAgentHost } = main('echocapAgentHost.js');
const { echoCapStatus, modelCall, resolveEndpoint } = main('echoCap.js');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const redact = (s) => String(s).replace(/(auth_key=)\S+/gi, '$1<redacted>');

console.log('== 1. EchoCap 端点 ==');
const ep = resolveEndpoint(true);
const status = echoCapStatus();
check('socket 已注入且可用', status.ok, status.ok ? redact(ep.socketPath) : status.message);
if (!status.ok) {
  console.log('\n无法继续：缺少 EchoCap 运行环境。');
  process.exit(2);
}

console.log('\n== 2. model.call（总结/写作/检索评估路径）==');
try {
  const r = await modelCall('只输出 JSON：{"sum":2}', { onProgress: () => {} });
  check('model.call 返回非空正文', !!r.text, `profile=${r.profile} text=${JSON.stringify(r.text.slice(0, 40))}`);
} catch (err) {
  check('model.call 返回非空正文', false, err.message);
}

console.log('\n== 3. AgentHost 对话收发（sub_agent.send + query → AgentEvent）==');
const sessionId = `verify-${Date.now()}`;
const host = new EchoCapAgentHost({ pollMs: 400 });
const events = [];
host.on(sessionId, (e) => {
  events.push(e);
  if (e.kind === 'text-delta') process.stdout.write(e.text);
});
try {
  const version = await host.start();
  check('宿主启动', host.ready, `version=${version}`);

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回合结束超时（150s）')), 150_000);
    host.on(sessionId, (e) => {
      if (e.kind === 'status' && e.status === 'idle') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  process.stdout.write('  助手输出：');
  await host.sendMessage(sessionId, '用一句话回答：1+1等于几？');
  await done;
  process.stdout.write('\n');

  const kinds = events.map((e) => e.kind);
  const text = events.filter((e) => e.kind === 'text-delta').map((e) => e.text).join('');
  const final = events.filter((e) => e.kind === 'assistant-message').map((e) => e.text).join('');
  check('发出 status:running', kinds.includes('status') && events.some((e) => e.status === 'running'));
  check('收到流式 text-delta', text.length > 0, `${text.length} 字符`);
  check('收到 assistant-message（落库来源）', !!final, JSON.stringify(final.slice(0, 60)));
  check('收到 finish', kinds.includes('finish'), events.find((e) => e.kind === 'finish')?.reason ?? '');
  check('回合收尾为 idle', kinds.lastIndexOf('status') >= 0 && events.at(-1).status === 'idle');
  check('无 error 事件', !kinds.includes('error'), events.find((e) => e.kind === 'error')?.message ?? '');
  check('文本增量与最终消息一致', text === final || final.startsWith(text));
  await host.close();
  check('宿主关闭', !host.ready);
} catch (err) {
  check('AgentHost 对话往返', false, err.message);
  await host.close().catch(() => {});
}

console.log('\n== 4. 凭证不出主进程 ==');
const assetsDir = path.join(root, 'web/assets');
const key = resolveEndpoint(true).authKey;
let leaked = [];
if (fs.existsSync(assetsDir)) {
  for (const f of fs.readdirSync(assetsDir)) {
    if (!/\.(js|mjs|css|html)$/.test(f)) continue;
    const body = fs.readFileSync(path.join(assetsDir, f), 'utf8');
    if (key && body.includes(key)) leaked.push(`${f}: 含 auth key`);
    if (body.includes('ECHO_CAP_AUTH_KEY')) leaked.push(`${f}: 含 ECHO_CAP_AUTH_KEY 字面量`);
  }
}
check('渲染层产物不含 CAP 凭证', leaked.length === 0, leaked.join('; '));

const failed = results.filter((r) => !r.ok);
console.log(`\n== 结果：${results.length - failed.length}/${results.length} 项通过 ==`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
