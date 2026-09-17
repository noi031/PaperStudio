import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { App } from './App';
import { installWebBridge } from './webBridge';

// 非 Electron 环境（Echo App Web 版）安装 HTTP+SSE 桥；Electron 下 preload 已注入、此处为 no-op。
installWebBridge();
import { theme } from './theme';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
