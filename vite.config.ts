/**
 * 前端开发配置：React 插件、开发端口，以及转发至 Express 的 /api 代理。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
  preview: { port: 4173 },
});
