#!/usr/bin/env node
// 本地/开发启动器：为 Web(Host) 服务端补齐本地默认环境变量后启动。
//
// 默认值（仅本地开发用；平台部署由平台注入，无需本脚本）：
//   ECHO_APP_HOST      127.0.0.1
//   ECHO_APP_PORT      18080
//   ECHO_APP_DATA_DIR  <项目根>/storage
//   ECHO_APP_WEB_DIR   <项目根>/web（npm run build 的前端产物）
//
// 用法：先 npm run build（前端产物）与 npm run build:host（服务端），再 node scripts/start-host.mjs
//       AI 后端按 backend.ts 自动解析（PAPERSTUDIO_BACKEND 环境变量可强制 dsh / echocap）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ECHO_APP_HOST ??= '127.0.0.1';
process.env.ECHO_APP_PORT ??= '18080';
process.env.ECHO_APP_DATA_DIR ??= path.join(root, 'storage');
process.env.ECHO_APP_WEB_DIR ??= path.join(root, 'web');

const server = path.join(root, 'dist-host', 'src', 'host', 'server.js');
const child = spawn(process.execPath, [server], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
