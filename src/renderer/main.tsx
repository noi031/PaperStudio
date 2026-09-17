import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { App } from './App';
import { installWebBridge } from './webBridge';

// 安装浏览器版 window.paper 桥（HTTP RPC + SSE，指向 Web(Host) 服务端）。
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
