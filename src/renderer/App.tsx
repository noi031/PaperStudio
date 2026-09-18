// 应用外壳：左侧导航 + 8 个工作区页面。
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import AppBar from '@mui/material/AppBar';
import SearchIcon from '@mui/icons-material/Search';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import ExploreIcon from '@mui/icons-material/Explore';
import EditNoteIcon from '@mui/icons-material/EditNote';
import SlideshowIcon from '@mui/icons-material/Slideshow';
import SettingsIcon from '@mui/icons-material/Settings';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import { SearchPage } from './pages/SearchPage';
import { LibraryPage } from './pages/LibraryPage';
import { ReaderPage } from './pages/ReaderPage';
import { DirectionsPage } from './pages/DirectionsPage';
import { WritingPage } from './pages/WritingPage';
import { PresentPage } from './pages/PresentPage';
import { AssistantPage } from './pages/AssistantPage';
import { SettingsPage } from './pages/SettingsPage';
import { useLibraryStore } from './store/libraryStore';

export type PageKey =
  | 'search'
  | 'library'
  | 'reader'
  | 'directions'
  | 'writing'
  | 'present'
  | 'assistant'
  | 'settings';

const NAV: Array<{ key: PageKey; label: string; icon: React.ReactNode }> = [
  { key: 'search', label: '检索', icon: <SearchIcon /> },
  { key: 'library', label: '文献库', icon: <LibraryBooksIcon /> },
  { key: 'reader', label: '阅读器', icon: <MenuBookIcon /> },
  { key: 'directions', label: '方向建议', icon: <ExploreIcon /> },
  { key: 'writing', label: '写作', icon: <EditNoteIcon /> },
  { key: 'present', label: '演示', icon: <SlideshowIcon /> },
  { key: 'assistant', label: 'AI 助手', icon: <SmartToyIcon /> },
  { key: 'settings', label: '设置', icon: <SettingsIcon /> },
];

export function App() {
  const [page, setPage] = useState<PageKey>('search');
  const [readerPaperId, setReaderPaperId] = useState<string | null>(null);
  const handleSummaryEvent = useLibraryStore((s) => s.handleSummaryEvent);
  const handlePapersEvent = useLibraryStore((s) => s.handlePapersEvent);

  // 订阅主进程 summary:event（选中/全文总结流式推送）。
  useEffect(() => window.paper.onSummaryEvent(handleSummaryEvent), [handleSummaryEvent]);

  // 订阅 papers:event（PDF 后台下载的进度与结果）。
  useEffect(() => window.paper.onPapersEvent(handlePapersEvent), [handlePapersEvent]);

  // 所有页面常驻挂载（切换时仅隐藏），跳转后再回来能恢复之前的界面状态
  // （检索词、分页、AI 检索结果、下载进度等）。
  const pages: Array<{ key: PageKey; node: React.ReactNode }> = [
    { key: 'search', node: <SearchPage /> },
    {
      key: 'library',
      node: (
        <LibraryPage
          onOpenPaper={(id) => {
            setReaderPaperId(id);
            setPage('reader');
          }}
        />
      ),
    },
    {
      key: 'reader',
      node: (
        <ReaderPage
          paperId={readerPaperId}
          onBack={() => setPage('library')}
          onOpenAssistant={() => setPage('assistant')}
        />
      ),
    },
    { key: 'directions', node: <DirectionsPage /> },
    { key: 'writing', node: <WritingPage /> },
    { key: 'present', node: <PresentPage /> },
    { key: 'assistant', node: <AssistantPage /> },
    { key: 'settings', node: <SettingsPage /> },
  ];

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          <Typography variant="h6" noWrap>
            PaperStudio
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{ width: 220, flexShrink: 0, '& .MuiDrawer-paper': { width: 220, boxSizing: 'border-box' } }}
      >
        <Toolbar />
        <List>
          {NAV.map((n) => (
            <ListItemButton key={n.key} selected={page === n.key} onClick={() => setPage(n.key)}>
              <ListItemIcon>{n.icon}</ListItemIcon>
              <ListItemText primary={n.label} />
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, p: 3, overflow: 'auto', mt: 8 }}>
        {pages.map((p) => (
          <Box key={p.key} sx={{ display: page === p.key ? 'block' : 'none', height: '100%' }}>
            {p.node}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
