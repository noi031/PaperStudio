// 导出文件的可点击下载地址：服务端绝对路径 → Web 端 /files/<文件区>/<文件名>。
//
// 存在意义：Web 版产物落在服务端数据目录里，把绝对路径当文本展示给用户没有意义
// （点不开，也不该暴露服务端目录结构）。这里按 server/src/host/server.ts 中 /files/
// 的文件区白名单（papers / exports / markdown）做映射，只暴露文件名对应的 URL；
// 无法映射时返回 null，调用方回退为不带路径的提示文案，绝不把绝对路径当可点击地址。

/** /files/ 支持的文件区（与 server 端白名单保持一致）。 */
const FILE_BUCKETS = new Set(['papers', 'exports', 'markdown']);

/** 取路径中的文件名（兼容 Windows 分隔符）。 */
export function fileNameOf(absPath: string | null | undefined): string {
  if (!absPath) return '';
  const parts = String(absPath).split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/** 绝对路径 → 可点击下载 URL；不属于已知文件区时返回 null。 */
export function downloadUrlOf(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const parts = String(absPath).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const bucket = parts[parts.length - 2];
  if (!FILE_BUCKETS.has(bucket)) return null;
  return `/files/${bucket}/${encodeURIComponent(name)}`;
}
