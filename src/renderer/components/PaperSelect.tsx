// 文献列表共享组件：按标题/作者/年份过滤论文 + 可搜索的论文 Select（写作/演示用）。
import React, { useMemo, useState } from 'react';
import TextField from '@mui/material/TextField';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import type { SelectProps, SxProps, Theme } from '@mui/material';
import type { PaperRecord } from '../../shared/types';
import { latexToText } from '../../shared/latex';

export function paperLabel(p: PaperRecord): string {
  return latexToText(p.title) || p.title || '未命名论文';
}

/** 按标题/作者/年份过滤论文（全部界面共用）。 */
export function filterPapers(papers: PaperRecord[], query: string): PaperRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return papers;
  return papers.filter((p) => {
    const title = paperLabel(p).toLowerCase();
    const authors = (p.authors ?? []).join(' ').toLowerCase();
    const year = p.year ? String(p.year) : '';
    return title.includes(q) || authors.includes(q) || year.includes(q);
  });
}

interface PaperSelectProps {
  papers: PaperRecord[];
  multiple?: boolean;
  value: string | string[];
  onChange: (value: string | string[]) => void;
  placeholder?: string;
  sx?: SxProps<Theme>;
}

/** 可搜索的论文下拉：弹出菜单顶部带搜索框，过滤标题/作者/年份。 */
export function SearchablePaperSelect({
  papers,
  multiple,
  value,
  onChange,
  placeholder = '选择论文…',
  sx,
}: PaperSelectProps) {
  const [query, setQuery] = useState('');
  const list = useMemo(() => filterPapers(papers, query), [papers, query]);
  return (
    <Select
      size="small"
      multiple={multiple}
      value={value}
      displayEmpty
      onChange={(e) => onChange(e.target.value as string | string[])}
      renderValue={(sel) => {
        if (multiple) return `${(sel as string[]).length} 篇参考`;
        return sel ? paperLabel(papers.find((p) => p.id === sel) as PaperRecord) || placeholder : placeholder;
      }}
      MenuProps={
        {
          PaperProps: { sx: { maxHeight: 360 } },
        } as SelectProps['MenuProps']
      }
      sx={{
        '& .MuiSelect-select': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        ...sx,
      }}
    >
      <ListSubheader sx={{ pt: 1, pb: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="搜索标题 / 作者 / 年份…"
          value={query}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => setQuery(e.target.value)}
        />
      </ListSubheader>
      {list.map((p) => (
        <MenuItem
          key={p.id}
          value={p.id}
          sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420 }}
        >
          {paperLabel(p).slice(0, 60)}
        </MenuItem>
      ))}
      {list.length === 0 && <MenuItem disabled>无匹配论文</MenuItem>}
    </Select>
  );
}