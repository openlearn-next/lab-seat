/**
 * PluginCenter — extracted plugin management UI (Discover + Developer tabs).
 *
 * Extracted from App.tsx lines 6295-6757 with zero visual delta per UI-SPEC.
 * Same class names, icons, structure — visually identical to the original.
 *
 * Props match the original App.tsx state and handlers.
 */

import React from 'react';
import {
  Puzzle,
  Blocks,
  Code,
  ShieldAlert,
  Upload,
  Wand2,
  Sparkles,
  Loader2,
  CheckCircle2,
  Shield,
  Terminal,
  PenTool,
  Eye,
  Users,
  Database,
  AlertTriangle,
  X,
  Settings,
  Github,
  FileText,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { LegacyPluginBadge } from './LegacyPluginBadge';
import type { Language } from '../i18n';
import JSZip from 'jszip';
import { PluginSettingsModal } from './PluginSettingsModal';
import { usePluginHostStore } from '../plugin-host/plugin-host-store';
import { PluginInstallWizard } from './PluginInstallWizard';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PluginType {
  id: string;
  name: string;
  status: string;
  created_at: number;
  manifest: string;
  execution_mode?: string;
  version?: string;
  has_frontend?: boolean;
}

interface ParsedManifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  capabilitiesProposed?: string[];
}

interface ParsedAction {
  id: string;
  commandType: string;
  description?: string;
}

export interface PluginCenterProps {
  plugins: PluginType[];
  lang: Language;
  storeTab: 'store' | 'widgets' | 'dev' | 'logs';
  setStoreTab: (tab: 'store' | 'widgets' | 'dev' | 'logs') => void;
  pluginCode: string;
  setPluginCode: (code: string) => void;
  installingPlugin: boolean;
  onInstall: () => void;
  onZipUpload: (
    file: File,
    executionMode: 'worker' | 'inline',
    opts?: { mode?: 'install' | 'update'; targetPluginId?: string; allowDowngrade?: boolean },
  ) => Promise<void>;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

// ── Capability Info (moved from App.tsx) ─────────────────────────────────────

const CAPABILITY_INFO: Record<string, {
  labelZh: string;
  labelEn: string;
  iconName: string;
  risk: 'low' | 'medium' | 'high';
  riskDescZh: string;
  riskDescEn: string;
}> = {
  'whiteboard:write': {
    labelZh: '写入交互白板内容',
    labelEn: 'Whiteboard Write Access',
    iconName: 'PenTool',
    risk: 'medium',
    riskDescZh: '中风险：允许插件在授课白板上自由擦写、增删几何教具和课件图形，会实时推送或改变所有在线学员的画板视图。',
    riskDescEn: 'Medium Risk: Authorizes the plugin to draw, erase, or alter whiteboard elements, live-syncing to all classroom attendees.',
  },
  'whiteboard:read': {
    labelZh: '读取白板元素图层',
    labelEn: 'Whiteboard Read Access',
    iconName: 'Eye',
    risk: 'low',
    riskDescZh: '低风险：仅读取白板当前的静态图形元素，用于做辅助的数据联动分析或内容导出。',
    riskDescEn: 'Low Risk: Read active static vectors or quiz properties from the blackboard without modification.',
  },
  'management:read': {
    labelZh: '读取教务学员名册',
    labelEn: 'School Directory Read',
    iconName: 'Users',
    risk: 'medium',
    riskDescZh: '中风险：允许插件遍历读取班级下的学生姓名、登录邮箱等档案信息（如在做点名提问筛选时）。',
    riskDescEn: 'Medium Risk: Allows retrieving list of enrolled students, email profiles, or attendance history.',
  },
  'management:write': {
    labelZh: '修改教务核心档案',
    labelEn: 'School Directory Write',
    iconName: 'Database',
    risk: 'high',
    riskDescZh: '高风险：强力权限！允许插件创建、编辑或彻底抹除班级列表、学生个人账号、授课日志及考勤成绩等多项核心教务系统档案。',
    riskDescEn: 'High Risk: Critical! Grants ability to modify academic profiles, drop students, change registers, or log grade-sheets.',
  },
};

// ── Plugin Source Parser (moved from App.tsx) ────────────────────────────────

const parsePluginSource = (sourceCode: string) => {
  let manifest: ParsedManifest | null = null;
  const actions: ParsedAction[] = [];

  try {
    const cleanCode = sourceCode
      .replace(/require\s*\(.*?\)/g, '{}')
      .replace(/import\s+.*?\s+from\s*['"].*?['"]/g, '');

    try {
      const runner = new Function('exports', `
        try {
          ${cleanCode};
          exports.default = exports.default || exports;
        } catch(e) {}
      `);
      const mockExports = {} as any;
      runner(mockExports);
      const evaluated = mockExports.default || mockExports;
      if (evaluated && evaluated.manifest) {
        manifest = evaluated.manifest;
      }
    } catch (e: any) {
      // Ignore evaluation error, fallback to regex
    }

    const idMatch = sourceCode.match(/id\s*:\s*['"]([^'"]+)['"]/);
    const nameMatch = sourceCode.match(/name\s*:\s*['"]([^'"]+)['"]/);
    const verMatch = sourceCode.match(/version\s*:\s*['"]([^'"]+)['"]/);
    const descMatch = sourceCode.match(/description\s*:\s*['"]([^'"]+)['"]/);
    const authorMatch = sourceCode.match(/author\s*:\s*['"]([^'"]+)['"]/);

    let capabilities: string[] = [];
    const capsMatch = sourceCode.match(/capabilitiesProposed\s*:\s*\[([\s\S]*?)\]/);
    if (capsMatch) {
      capabilities = capsMatch[1]
        .split(',')
        .map(s => s.replace(/['"\s]/g, ''))
        .filter(s => s.length > 0);
    }

    manifest = manifest || {
      id: idMatch?.[1],
      name: nameMatch?.[1],
      version: verMatch?.[1],
      description: descMatch?.[1],
      author: authorMatch?.[1],
      capabilitiesProposed: capabilities,
    };

    // Parse actions from code
    const actionMatches = sourceCode.matchAll(/actionRegistry\.register\(\{([\s\S]*?)\}\)/g);
    for (const match of actionMatches) {
      const block = match[1];
      const aId = block.match(/id\s*:\s*['"]([^'"]+)['"]/)?.[1];
      const aCmdType = block.match(/commandType\s*:\s*['"]([^'"]+)['"]/)?.[1];
      const aDesc = block.match(/description\s*:\s*['"]([^'"]+)['"]/)?.[1];
      if (aId && aCmdType) {
        actions.push({ id: aId, commandType: aCmdType, description: aDesc });
      }
    }
  } catch (e) {
    console.warn('Failed to parse plugin source:', e);
  }

  return { manifest: manifest || undefined, actions };
};

// ── DEFAULT_PLUGIN (示例模板) ─────────────────────────────────────────────────

const DEFAULT_PLUGIN = `exports.default = {
  manifest: {
    id: "@my-scope/hello-world",
    name: "Hello World Plugin",
    version: "1.0.0",
    capabilitiesProposed: ["lesson:read"]
  },
  activate: async (ctx) => {
    ctx.log.info('Hello World plugin activated');
  }
};`;

// ── Component ───────────────────────────────────────────────────────────────

function LogsPanel({ lang }: { lang: Language }) {
  const [logs, setLogs] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [autoRefresh, setAutoRefresh] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [levelFilter, setLevelFilter] = React.useState('');
  const [componentFilter, setComponentFilter] = React.useState('');

  const fetchLogs = async () => {
    setLoading(true);
    try {
      let url = '/api/admin/logs?limit=300';
      if (levelFilter) url += `&level=${levelFilter}`;
      if (componentFilter) url += `&component=${componentFilter}`;
      
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs || []);
      }
    } catch (e) {
      console.error('Error fetching logs:', e);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    fetchLogs();
  }, [levelFilter, componentFilter]);

  React.useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      let url = '/api/admin/logs?limit=300';
      if (levelFilter) url += `&level=${levelFilter}`;
      if (componentFilter) url += `&component=${componentFilter}`;
      fetch(url)
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            setLogs(data.logs || []);
          }
        })
        .catch(e => console.error(e));
    }, 3000);
    return () => clearInterval(timer);
  }, [autoRefresh, levelFilter, componentFilter]);

  const components = React.useMemo(() => {
    const set = new Set<string>();
    logs.forEach(log => {
      if (log.component) set.add(log.component);
    });
    return Array.from(set);
  }, [logs]);

  const filteredLogs = React.useMemo(() => {
    if (!search) return logs;
    const query = search.toLowerCase();
    return logs.filter(log => {
      const msg = (log.msg || '').toLowerCase();
      const comp = (log.component || '').toLowerCase();
      return msg.includes(query) || comp.includes(query);
    });
  }, [logs, search]);

  const levelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-rose-500 font-semibold';
      case 'warn': return 'text-amber-500 font-semibold';
      case 'debug': return 'text-blue-400';
      default: return 'text-emerald-400';
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 bg-slate-900 text-slate-100 font-mono text-sm overflow-hidden h-full min-h-[500px]">
      <div className="flex flex-wrap gap-4 items-center justify-between border-b border-slate-800 pb-4 shrink-0 font-sans">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="text"
            placeholder={lang === 'zh' ? '搜索日志内容...' : 'Search logs...'}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg focus:outline-none focus:border-indigo-500 placeholder-slate-500 text-xs w-48"
          />
          <select
            value={levelFilter}
            onChange={e => setLevelFilter(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg focus:outline-none focus:border-indigo-500 text-xs"
          >
            <option value="">{lang === 'zh' ? '所有级别' : 'All Levels'}</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
            <option value="debug">DEBUG</option>
          </select>
          <select
            value={componentFilter}
            onChange={e => setComponentFilter(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 px-3 py-1.5 rounded-lg focus:outline-none focus:border-indigo-500 text-xs max-w-48"
          >
            <option value="">{lang === 'zh' ? '所有组件' : 'All Components'}</option>
            {components.map(comp => (
              <option key={comp} value={comp}>{comp}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-slate-400 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="rounded bg-slate-800 border-slate-700 text-indigo-500 focus:ring-0 focus:ring-offset-0"
            />
            {lang === 'zh' ? '自动刷新 (3s)' : 'Auto-refresh (3s)'}
          </label>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="bg-slate-800 hover:bg-slate-700 active:bg-slate-750 text-slate-200 border border-slate-700 px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50 cursor-pointer"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : null}
            {lang === 'zh' ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto mt-4 p-4 bg-slate-950 border border-slate-800 rounded-xl flex flex-col gap-1.5 min-h-0 select-text">
        {filteredLogs.length === 0 ? (
          <div className="text-slate-500 text-center py-12 select-none font-sans">
            {lang === 'zh' ? '暂无匹配的运行日志' : 'No logs found.'}
          </div>
        ) : (
          filteredLogs.map((log, index) => (
            <div key={index} className="leading-relaxed hover:bg-slate-900/50 px-1.5 py-0.5 rounded transition-colors flex items-start gap-2.5">
              <span className="text-slate-500 select-none shrink-0 font-mono text-xs">
                {new Date(log.time).toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 })}
              </span>
              <span className={`uppercase text-xs shrink-0 select-none font-bold w-12 tracking-wide ${levelColor(log.level)}`}>
                [{log.level}]
              </span>
              {log.component && (
                <span className="text-blue-400 font-semibold shrink-0 select-none">
                  [{log.component}]
                </span>
              )}
              <span className="text-slate-200 flex-1 whitespace-pre-wrap break-all">
                {log.msg}
                {log.meta && Object.keys(log.meta).length > 0 && (
                  <span className="text-slate-500 text-xs ml-2 select-all">
                    ({JSON.stringify(log.meta)})
                  </span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function PluginCenter({
  plugins,
  lang,
  storeTab,
  setStoreTab,
  pluginCode,
  setPluginCode,
  installingPlugin,
  onInstall,
  onZipUpload,
  onToggle,
  onDelete,
}: PluginCenterProps) {
  // ── Local state ──────────────────────────────────────────────────────────

  const [showSystemPlugins, setShowSystemPlugins] = React.useState(false);
  const [dismissMigration, setDismissMigration] = React.useState(false);
  const [selectedZipFile, setSelectedZipFile] = React.useState<File | null>(null);
  /** When set, wizard is opened from a card "Update" action and locked to that plugin. */
  const [updateTargetPluginId, setUpdateTargetPluginId] = React.useState<string | null>(null);
  const updateFileInputRef = React.useRef<HTMLInputElement>(null);

  // ZIP upload state (error messages, preview metadata, processing indicator)
  const [zipError, setZipError] = React.useState<string | null>(null);
  const [zipPreview, setZipPreview] = React.useState<{ name: string; id: string; version: string } | null>(null);
  const [zipProcessing, setZipProcessing] = React.useState(false);

  // V3.1: Settings modal state
  const [settingsPlugin, setSettingsPlugin] = React.useState<{ id: string; name: string; manifest: string } | null>(null);

  // Dashboard visibility — read the whole map at the component level (NOT inside .map())
  const dashboardVisibilityMap = usePluginHostStore((s) => s.dashboardVisibility);

  // Market feed & one-click update states
  const [marketMap, setMarketMap] = React.useState<Map<string, any>>(new Map());
  const [oneClickUpdatingId, setOneClickUpdatingId] = React.useState<string | null>(null);
  const [checkingUpdateId, setCheckingUpdateId] = React.useState<string | null>(null);
  const [changelogModalPlugin, setChangelogModalPlugin] = React.useState<any | null>(null);
  const [updateToast, setUpdateToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    let isMounted = true;
    fetch('/api/plugins/market')
      .then((r) => r.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.market) && isMounted) {
          const map = new Map<string, any>();
          for (const item of data.market) {
            map.set(item.manifestId, item);
          }
          setMarketMap(map);
        }
      })
      .catch(() => {});
    return () => { isMounted = false; };
  }, []);

  const handleCheckUpdate = async (pluginId: string, manifestId: string) => {
    setCheckingUpdateId(pluginId);
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/check-update`, {
        method: 'POST',
      }).then((r) => r.json());
      if (res?.success) {
        setMarketMap((prev) => {
          const next = new Map(prev);
          next.set(manifestId, { ...res, manifestId });
          return next;
        });
      }
    } catch {
      // ignore
    } finally {
      setCheckingUpdateId(null);
    }
  };

  const handleOneClickUpdate = async (pluginId: string, marketItem?: any) => {
    setOneClickUpdatingId(pluginId);
    setUpdateToast(lang === 'zh' ? '正在连接市场执行一键无缝热更新...' : 'Connecting to market for one-click hot update...');

    try {
      const body = marketItem?.downloadUrl ? JSON.stringify({ downloadUrl: marketItem.downloadUrl }) : undefined;
      const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/one-click-update`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
      }).then((r) => r.json());

      if (res?.success) {
        setUpdateToast(lang === 'zh' ? `🎉 插件已成功热更新至 v${res.newVersion || '1.2.0'}！` : `🎉 Hot updated to v${res.newVersion || '1.2.0'}!`);
        setTimeout(() => window.location.reload(), 1200);
      } else if (res?.fallbackToClient && marketItem?.downloadUrl) {
        setUpdateToast(lang === 'zh' ? '服务端下载超时，切换至浏览器直传...' : 'Server download timed out, switching to browser transfer...');
        try {
          const zipResp = await fetch(marketItem.downloadUrl);
          const blob = await zipResp.blob();
          const formData = new FormData();
          formData.append('file', blob, 'update.zip');
          const uploadRes = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/update-zip-raw`, {
            method: 'POST',
            headers: { 'x-install-mode': 'update' },
            body: formData,
          }).then((r) => r.json());
          if (uploadRes?.success) {
            setUpdateToast(lang === 'zh' ? `🎉 插件已成功热更新！` : `🎉 Hot updated!`);
            setTimeout(() => window.location.reload(), 1200);
          } else {
            setUpdateToast(`❌ 更新失败: ${uploadRes?.error || '客户端上传失败'}`);
            setTimeout(() => setUpdateToast(null), 4000);
          }
        } catch (e2: any) {
          setUpdateToast(`❌ 客户端下载失败: ${e2.message}`);
          setTimeout(() => setUpdateToast(null), 4000);
        }
      } else {
        setUpdateToast(`❌ 更新失败: ${res?.error || '受热更新包限制'}`);
        setTimeout(() => setUpdateToast(null), 4000);
      }
    } catch (e: any) {
      setUpdateToast(`❌ 一键热更新失败: ${e.message}`);
      setTimeout(() => setUpdateToast(null), 4000);
    } finally {
      setOneClickUpdatingId(null);
    }
  };

  // ── ZIP drop zone handler ─────────────────────────────────────────────────

  const handleZipDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-indigo-400', 'bg-indigo-50/50');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      setUpdateTargetPluginId(null);
      setSelectedZipFile(files[0]);
    }
  };

  // ── ZIP upload change handler with preview ───────────────────────────────

  const handleZipInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedZipFile(file);
    }
  };

  // ── MigrationPrompt component ────────────────────────────────────────────

  const hasLegacyPlugins = plugins.some(p => p.execution_mode === 'legacy');

  function MigrationPromptBanner() {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start justify-between mb-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="text-amber-500 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-bold text-amber-800">
              {lang === 'zh' ? '发现可迁移的旧格式插件' : 'Legacy Plugin Detected'}
            </h4>
            <p className="text-xs text-amber-700 mt-1">
              {lang === 'zh'
                ? '该插件使用旧格式运行。上传新格式 ZIP 包以完成迁移，迁移后旧版本可安全卸载。'
                : 'This plugin runs in legacy mode. Upload a new-format ZIP package to migrate. The old version can be safely uninstalled afterwards.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => document.getElementById('zip-plugin-uploader')?.click()}
            className="bg-amber-600 text-white hover:bg-amber-700 rounded-lg text-sm font-medium px-4 py-2 transition-colors"
          >
            {lang === 'zh' ? '迁移到新格式' : 'Migrate to New Format'}
          </button>
          <button
            onClick={() => setDismissMigration(true)}
            className="text-amber-500 hover:text-amber-700 p-1"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex-1 flex flex-col h-full overflow-y-auto">
      {/* App Store Module */}
      <div className="bg-white border text-gray-900 border-gray-200 rounded-2xl shadow flex flex-col overflow-hidden h-full">
        <div className="px-6 py-4 flex items-center justify-between border-b border-gray-100 bg-gray-50/50 shrink-0">
          <div className="flex items-center gap-6">
            <h2 className="font-bold text-gray-900 flex items-center gap-2 text-lg">
              <Puzzle size={20} className="text-indigo-600" />
              {lang === 'zh' ? 'Edu OS 插件中心' : 'Edu OS App Store'}
            </h2>
            <div className="flex bg-gray-200/50 p-1 rounded-lg">
              <button
                onClick={() => setStoreTab('store')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  storeTab === 'store'
                    ? 'bg-white shadow text-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {lang === 'zh' ? '发现' : 'Discover'}
              </button>
              <button
                onClick={() => setStoreTab('dev')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1 ${
                  storeTab === 'dev'
                    ? 'bg-white shadow text-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Code size={14} /> {lang === 'zh' ? '开发者' : 'Developer'}
              </button>
              <button
                onClick={() => setStoreTab('logs')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1 ${
                  storeTab === 'logs'
                    ? 'bg-white shadow text-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Terminal size={14} /> {lang === 'zh' ? '系统日志' : 'Logs'}
              </button>
            </div>
          </div>
          {/* Toggle show system plugins */}
         {storeTab === 'store' && (
            <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-gray-500 hover:text-gray-900 select-none transition-colors border border-gray-200 rounded-lg px-3 py-1.5 bg-gray-50/50 shadow-sm">
              <input
                type="checkbox"
                checked={showSystemPlugins}
                onChange={(e) => setShowSystemPlugins(e.target.checked)}
                className="w-3.5 h-3.5 rounded text-indigo-600 border-gray-300 focus:ring-indigo-500 cursor-pointer"
              />
              <span>{lang === 'zh' ? '显示系统核心插件' : 'Show System Core Plugins'}</span>
            </label>

            {/* Inline ZIP drop zone */}
            <div
              className={`flex items-center gap-1.5 cursor-pointer text-xs font-semibold select-none transition-colors border rounded-lg px-3 py-1.5 shadow-sm ${
                selectedZipFile
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-teal-200 bg-teal-50/50 text-teal-600 hover:border-teal-400 hover:bg-teal-50'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('border-teal-400', 'bg-teal-50');
              }}
              onDragLeave={(e) => {
                e.currentTarget.classList.remove('border-teal-400', 'bg-teal-50');
              }}
              onDrop={handleZipDrop}
              onClick={() => {
                document.getElementById('zip-plugin-uploader')?.click();
              }}
            >
              {selectedZipFile ? (
                <>
                  <CheckCircle2 size={14} className="text-emerald-500" />
                  <span className="max-w-[120px] truncate">{selectedZipFile.name}</span>
                </>
              ) : (
                <>
                  <Upload size={14} />
                  <span>{lang === 'zh' ? '拖拽安装 ZIP' : 'Drop ZIP'}</span>
                </>
              )}
            </div>
            </div>
          )}
        </div>

        {/* 隐藏文件上传输入框 — 同时服务于发现页和开发者页 */}
        <input
          type="file"
          accept=".zip"
          id="zip-plugin-uploader"
          className="hidden"
          onChange={(e) => {
            setUpdateTargetPluginId(null);
            handleZipInputChange(e);
          }}
        />
        {/* Card-level Update picker — locks wizard to a specific plugin id */}
        <input
          ref={updateFileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setSelectedZipFile(f);
            e.target.value = '';
          }}
        />

        {storeTab === 'store' ? (
         <div className="flex-1 overflow-y-auto p-6 bg-gray-50/30">
            <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-4 gap-4">
              {plugins
                .filter((p) => {
                  const isSystem = p.id.startsWith('@openlearn/');
                  return showSystemPlugins ? true : !isSystem;
                })
                .map((plugin) => {
                let manifestInfo: {
                  description: string;
                  author: string;
                  version: string;
                  manifestId: string;
                  capabilities: string[];
                  toolCount: number;
                  studentViewCount: number;
                  teacherWidgetCount: number;
                  hasConfig: boolean;
                  repository: string;
                  homepage: string;
                  updateSource?: { type: string; repo: string };
                } = {
                  description: '扩展 Edu OS 功能的自定义插件。',
                  author: 'Community',
                  version: '',
                  manifestId: '',
                  capabilities: [],
                  toolCount: 0,
                  studentViewCount: 0,
                  teacherWidgetCount: 0,
                  hasConfig: false,
                  repository: '',
                  homepage: '',
                };
                try {
                  const parsed = JSON.parse(plugin.manifest);
                  if (parsed.description) manifestInfo.description = parsed.description;
                  if (parsed.author) manifestInfo.author = parsed.author;
                  if (parsed.version) manifestInfo.version = parsed.version;
                  if (parsed.id) manifestInfo.manifestId = parsed.id;
                  if (parsed.repository) {
                    manifestInfo.repository = typeof parsed.repository === 'string' ? parsed.repository : (parsed.repository.url || '');
                  }
                  if (parsed.homepage) manifestInfo.homepage = parsed.homepage;
                  if (parsed.capabilitiesProposed) manifestInfo.capabilities = parsed.capabilitiesProposed;
                  if (parsed.contributes?.['classroom.tool']) {
                    manifestInfo.toolCount = parsed.contributes['classroom.tool'].length;
                  } else if (parsed.classroomTools) {
                    manifestInfo.toolCount = parsed.classroomTools.length;
                  }
                  if (parsed.contributes?.['student.view']) {
                    manifestInfo.studentViewCount = parsed.contributes['student.view'].length;
                  }
                  if (parsed.contributes?.['teacher.dashboard.widget']) {
                    manifestInfo.teacherWidgetCount = parsed.contributes['teacher.dashboard.widget'].length;
                  }
                  const props = parsed.configuration?.properties;
                  if (props && Object.keys(props).length > 0) {
                    manifestInfo.hasConfig = true;
                  }
                  if (parsed.updateSource?.type && parsed.updateSource?.repo) {
                    manifestInfo.updateSource = parsed.updateSource;
                  }
                } catch (e) {
                  // ignore parse error
                }

                const installDate = plugin.created_at
                  ? new Date(plugin.created_at).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                  : '—';

                const isSystem = plugin.id.startsWith('@openlearn/');

                // Dashboard visibility toggle — looked up from pre-read map
                const dashboardVisible = dashboardVisibilityMap.get(plugin.id) ?? true;

                // Query market item for version comparison
                const marketItem = marketMap.get(manifestInfo.manifestId || plugin.id);
                const hasUpdate = Boolean(marketItem?.hasUpdate);
                const updateError = marketItem?.error || null;

                return (
                  <div
                    key={plugin.id}
                    className={`bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-all relative overflow-hidden group flex flex-col gap-3 h-full ${
                      plugin.status !== 'active' ? 'opacity-75' : ''
                    }`}
                  >
                    {/* Status & type badges */}
                    <div className="absolute top-0 right-0 p-3 flex items-center gap-1.5 flex-wrap justify-end">
                    {hasUpdate && (
                        <span
                          title={lang === 'zh'
                            ? `点击查看新特性${marketItem.isPrerelease ? '（预发布版本）' : ''}并升级至 v${marketItem.latestVersion}`
                            : `Upgradeable to v${marketItem.latestVersion}${marketItem.isPrerelease ? ' (pre-release)' : ''}`}
                          className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full shadow-sm flex items-center gap-1 shrink-0 cursor-pointer ${
                            marketItem.isPrerelease
                              ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white animate-pulse'
                              : 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white animate-pulse'
                          }`}
                          onClick={() => setChangelogModalPlugin({ ...plugin, marketItem })}
                        >
                          <span>
                            {marketItem.isPrerelease ? '🔶 ' : '⚡ '}
                            {lang === 'zh'
                              ? `${marketItem.isPrerelease ? '预发布 ' : '发现新版本 '}v${marketItem.latestVersion}`
                              : `${marketItem.isPrerelease ? 'Pre-release ' : 'New '}v${marketItem.latestVersion}`}
                          </span>
                        </span>
                      )}
                      {updateError && !hasUpdate && (
                        <span
                          title={updateError}
                          className="text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-0.5 rounded-full flex items-center gap-1 shrink-0 cursor-default"
                        >
                          <span>⚠️ {lang === 'zh' ? '检查失败' : 'Check failed'}</span>
                        </span>
                      )}
                      <span
                        className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full flex items-center gap-1 border transition-all ${
                          plugin.status === 'active'
                            ? 'bg-emerald-50 text-emerald-750 border-emerald-250'
                            : 'bg-slate-100 text-slate-500 border-slate-200'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${plugin.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                        <span>
                          {plugin.status === 'active'
                            ? (lang === 'zh' ? '已启用' : 'ACTIVE')
                            : (lang === 'zh' ? '已停用' : 'INACTIVE')
                          }
                        </span>
                      </span>
                      {plugin.execution_mode === 'esm' && (
                        <span className="text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-150 px-1.5 py-0.5 rounded uppercase tracking-wider">
                          ESM
                        </span>
                      )}
                      {(plugin as any).execution_mode === 'legacy' && (
                        <LegacyPluginBadge lang={lang} />
                      )}
                      {isSystem && (
                        <span className="text-[10px] font-bold bg-violet-50 text-violet-700 border border-violet-200 px-1.5 py-0.5 rounded uppercase tracking-wider">
                          {lang === 'zh' ? '系统' : 'SYSTEM'}
                        </span>
                      )}
                    </div>

                    {/* Icon + name */}
                    <div className="flex items-start gap-3 pr-24">
                      <div className="w-11 h-11 bg-indigo-50 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100 group-hover:bg-indigo-600 group-hover:text-white transition-colors shrink-0">
                        <Blocks size={22} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-semibold text-gray-900 line-clamp-1">{plugin.name}</h4>
                          {manifestInfo.version && (
                            <span className="text-[10px] font-mono font-bold bg-gray-100 text-gray-500 border border-gray-200 px-1.5 py-0.5 rounded shrink-0">
                              v{manifestInfo.version}
                            </span>
                          )}
                        </div>
                        {manifestInfo.manifestId && (
                          <p className="text-[10px] text-gray-400 font-mono truncate mt-0.5" title={manifestInfo.manifestId}>
                            {manifestInfo.manifestId}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Description */}
                    <p className="text-xs text-gray-500 line-clamp-2 leading-relaxed">
                      {manifestInfo.description}
                    </p>

                    {/* Contribution points */}
                    {(manifestInfo.toolCount > 0 || manifestInfo.studentViewCount > 0 || manifestInfo.teacherWidgetCount > 0) && (
                      <div className="flex flex-wrap gap-1.5">
                        {manifestInfo.toolCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-indigo-50 text-indigo-600 border border-indigo-100 px-2 py-0.5 rounded-full">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                            {lang === 'zh' ? `${manifestInfo.toolCount} 个课堂工具` : `${manifestInfo.toolCount} classroom tool${manifestInfo.toolCount > 1 ? 's' : ''}`}
                          </span>
                        )}
                        {manifestInfo.studentViewCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-sky-50 text-sky-600 border border-sky-100 px-2 py-0.5 rounded-full">
                            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                            {lang === 'zh' ? `${manifestInfo.studentViewCount} 个学生视图` : `${manifestInfo.studentViewCount} student view${manifestInfo.studentViewCount > 1 ? 's' : ''}`}
                          </span>
                        )}
                        {manifestInfo.teacherWidgetCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-100 px-2 py-0.5 rounded-full">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                            {lang === 'zh' ? `${manifestInfo.teacherWidgetCount} 个教师组件` : `${manifestInfo.teacherWidgetCount} teacher widget${manifestInfo.teacherWidgetCount > 1 ? 's' : ''}`}
                          </span>
                        )}
                        {manifestInfo.capabilities.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-rose-50 text-rose-600 border border-rose-100 px-2 py-0.5 rounded-full">
                            <Shield size={9} />
                            {lang === 'zh' ? `${manifestInfo.capabilities.length} 项权限` : `${manifestInfo.capabilities.length} permission${manifestInfo.capabilities.length > 1 ? 's' : ''}`}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Footer: metadata + actions pinned to card bottom for cross-card alignment */}
                    <div className="mt-auto flex flex-col gap-3 pt-1">
                    {/* Metadata strip: author + git repository link + install date */}
                    <div className="flex items-center justify-between text-[10px] text-gray-400 border-t border-gray-100 pt-2 gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="flex items-center gap-1 min-w-0">
                          <Users size={10} className="shrink-0 text-gray-400" />
                          <span className="truncate">{manifestInfo.author}</span>
                        </span>
                        {(manifestInfo.repository || manifestInfo.homepage || marketItem?.repository) && (
                          <a
                            href={manifestInfo.repository || manifestInfo.homepage || marketItem?.repository}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={lang === 'zh' ? '查看 Git 开源仓库 (GitHub/Gitee)' : 'View Git Repository'}
                            className="inline-flex items-center gap-1 text-[10px] font-mono text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-1.5 py-0.5 rounded border border-indigo-200/60 transition-colors shrink-0"
                          >
                            <Github size={10} />
                            <span className="truncate max-w-[130px]">
                              {(manifestInfo.repository || manifestInfo.homepage || marketItem?.repository).replace(/^https?:\/\//, '')}
                            </span>
                          </a>
                        )}
                      </div>
                      <span className="flex items-center gap-1 shrink-0 ml-auto">
                        <span>{lang === 'zh' ? '安装于' : 'Installed'}</span>
                        <span className="font-mono">{installDate}</span>
                      </span>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1.5 flex-wrap min-h-[34px]">
                      {manifestInfo.updateSource && (
                        <button
                          onClick={() => handleCheckUpdate(plugin.id, manifestInfo.manifestId || plugin.id)}
                          disabled={checkingUpdateId === plugin.id}
                          className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                            hasUpdate
                              ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                              : updateError
                              ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                              : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
                          }`}
                          title={lang === 'zh' ? '手动检查远端更新' : 'Check for updates'}
                        >
                          {checkingUpdateId === plugin.id ? (
                            <RefreshCw size={12} className="animate-spin" />
                          ) : (
                            <RefreshCw size={12} />
                          )}
                          <span>{lang === 'zh' ? '检查更新' : 'Check'}</span>
                        </button>
                      )}
                      {hasUpdate ? (
                        <>
                          <button
                            onClick={() => handleOneClickUpdate(plugin.id, marketItem)}
                            disabled={oneClickUpdatingId === plugin.id}
                            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-sm transition-all flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                          >
                            {oneClickUpdatingId === plugin.id ? (
                              <RefreshCw size={12} className="animate-spin" />
                            ) : (
                              <span>🚀 {lang === 'zh' ? `一键热更新 v${marketItem.latestVersion}` : `Update v${marketItem.latestVersion}`}</span>
                            )}
                          </button>
                          <button
                            onClick={() => setChangelogModalPlugin({ ...plugin, marketItem })}
                            className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200/60 transition-colors flex items-center gap-1 cursor-pointer"
                          >
                            <FileText size={12} />
                            <span>{lang === 'zh' ? '新特性' : 'Notes'}</span>
                          </button>
                        </>
                      ) : null}
                      <button
                        onClick={() => onToggle(plugin.id)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                          plugin.status === 'active'
                            ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                            : 'bg-green-50 text-green-600 hover:bg-green-100'
                        }`}
                      >
                        {plugin.status === 'active'
                          ? lang === 'zh' ? '禁用' : 'Disable'
                          : lang === 'zh' ? '启用' : 'Enable'}
                      </button>
                      {/* Dashboard visibility toggle (Switch style, aligned with other action buttons) */}
                      <button
                        onClick={() => {
                          const next = !dashboardVisible;
                          usePluginHostStore.getState().setDashboardVisibility(plugin.id, next);
                        }}
                        title={dashboardVisible
                          ? (lang === 'zh' ? '在系统总览中隐藏' : 'Hide from Dashboard')
                          : (lang === 'zh' ? '在系统总览中显示' : 'Show in Dashboard')
                        }
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                          dashboardVisible
                            ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200/60'
                            : 'bg-gray-50 text-gray-500 hover:bg-gray-100 border border-gray-200/60'
                        }`}
                      >
                        <span>{lang === 'zh' ? '总览' : 'Dash'}</span>
                        <span
                          className={`w-7 h-3.5 rounded-full transition-colors flex items-center p-0.5 shrink-0 ${
                            dashboardVisible ? 'bg-indigo-600' : 'bg-gray-300'
                          }`}
                        >
                          <span
                            className={`w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform ${
                              dashboardVisible ? 'translate-x-3.5' : 'translate-x-0'
                            }`}
                          />
                        </span>
                      </button>
                      {manifestInfo.hasConfig && (
                        <button
                          onClick={() => setSettingsPlugin({ id: plugin.id, name: plugin.name, manifest: plugin.manifest })}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors flex items-center gap-1"
                        >
                          <Settings size={12} />
                          {lang === 'zh' ? '设置' : 'Settings'}
                        </button>
                      )}
                      {!isSystem && (
                        <>
                          <button
                            onClick={() => {
                              setUpdateTargetPluginId(plugin.id);
                              updateFileInputRef.current?.click();
                            }}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-50 text-sky-700 hover:bg-sky-100 transition-colors"
                          >
                            {lang === 'zh' ? '更新' : 'Update'}
                          </button>
                          <button
                            onClick={() => onDelete(plugin.id)}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                          >
                            {lang === 'zh' ? '删除' : 'Delete'}
                          </button>
                        </>
                      )}
                      {plugin.execution_mode === 'legacy' && (
                        <button
                          onClick={() => document.getElementById('zip-plugin-uploader')?.click()}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                          title={lang === 'zh' ? '上传新格式 ZIP 包以完成迁移' : 'Upload new-format ZIP package to migrate'}
                        >
                          {lang === 'zh' ? '迁移' : 'Migrate'}
                        </button>
                      )}
                    </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : storeTab === 'logs' ? (
          <LogsPanel lang={lang} />
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden bg-gray-950">
            <div className="p-4 bg-gray-900 border-b border-gray-800 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <ShieldAlert size={16} className="text-amber-400" />
                <div>
                  <p className="text-xs font-semibold text-gray-200">
                    {lang === 'zh'
                      ? '开发者工具: 插件旁路加载与实时 Manifest 校验'
                      : 'Developer Tools: Plugin Sideloading & Real-time Manifest Validation'}
                  </p>
                  <p className="text-[10px] text-gray-505">
                    {lang === 'zh'
                      ? '在安装前系统将进行解析、安全授权与注册接口预览机制'
                      : 'Parse metadata, proposed permissions, and registered triggers before installation'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Phase 9: Enhanced ZIP drop zone with processing/preview states */}
                <div
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] uppercase font-bold rounded-lg cursor-pointer transition-all ${
                    zipError
                      ? 'border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
                      : zipPreview
                        ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                        : zipProcessing
                          ? 'border border-indigo-500/30 bg-indigo-500/10 text-indigo-400'
                          : 'border border-dashed border-gray-600 text-gray-400 hover:text-white hover:border-indigo-400 hover:bg-indigo-500/10'
                  }`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add('border-indigo-400', 'bg-indigo-50/50');
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.classList.remove('border-indigo-400', 'bg-indigo-50/50');
                  }}
                  onDrop={handleZipDrop}
                  onClick={() => {
                    setZipError(null);
                    setZipPreview(null);
                    document.getElementById('zip-plugin-uploader')?.click();
                  }}
                >
                  {zipProcessing ? (
                    <>
                      <Loader2 size={11} className="animate-spin" />
                      <span>{lang === 'zh' ? '分析中...' : 'Analyzing...'}</span>
                    </>
                  ) : zipPreview ? (
                    <>
                      <CheckCircle2 size={11} />
                      <span className="max-w-[100px] truncate">{zipPreview.name}</span>
                    </>
                  ) : zipError ? (
                    <>
                      <ShieldAlert size={11} />
                      <span>{lang === 'zh' ? '重试' : 'Retry'}</span>
                    </>
                  ) : (
                    <>
                      <Upload size={11} />
                      <span>{lang === 'zh' ? '拖拽安装' : 'Drop ZIP'}</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setPluginCode(DEFAULT_PLUGIN)}
                  className="px-2.5 py-1 text-[10px] uppercase font-bold text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-all flex items-center gap-1 cursor-pointer"
                  title="Reset to default multi-choice quiz generator example"
                >
                  <Wand2 size={11} className="text-indigo-450" />
                  {lang === 'zh' ? '示例：智能测验生成器' : 'Quiz Sample'}
                </button>
                <button
                  onClick={() => {
                    setPluginCode(`exports.default = {
  manifest: {
    id: "ext-roll-call",
    name: "Random Student Picker (随机点名小工具)",
    version: "1.0.0",
    description: "可在授课白板上直接拖拽出的互动随机点名板，对课堂提问并同步点名记录至交互画板大有裨益。",
    author: "CoreOS Team",
    capabilitiesProposed: ["whiteboard:write", "management:read"]
  },
  activate: async (ctx) => {
    ctx.actionRegistry.register({
      id: 'ext-rollcall-pick',
      commandType: 'rollcall.pick',
      description: '从班级中随机抽取一名学生进行课堂提问/点名，并投射到交互画板上',
      capabilityRequired: 'management:read',
      inputSchema: {
        type: 'OBJECT',
        properties: {
          classId: { type: 'STRING', description: '班级 ID (必传，提取名册)' },
          lessonId: { type: 'STRING', description: '关联课时 ID (将点名效果同步投射到该课时白板上)' }
        },
        required: ['classId']
      }
    });

    ctx.commandBus.registerHandler('rollcall.pick', {
      execute: async (command) => {
        const payload = command.payload;
        const classId = payload.classId;
        const lessonId = payload.lessonId;

        let students = [];
        try {
          const res = await ctx.commandBus.execute({
            id: 'int_' + Math.random().toString(36).slice(2),
            type: 'class.get_students',
            actorId: 'plugin-rollcall',
            payload: { classId }
          });
          if (res && res.students) {
            students = res.students;
          }
        } catch (e) {
          console.error("Failed to fetch class students via command bus", e);
        }

        if (students.length === 0) {
          students = [
            { id: "mock-s-1", name: "张明", email: "zhangming@edu-os.org" },
            { id: "mock-s-2", name: "李华", email: "lihua@edu-os.org" },
            { id: "mock-s-3", name: "王超", email: "wangchao@edu-os.org" },
            { id: "mock-s-4", name: "赵丽", email: "zhaoli@edu-os.org" }
          ];
        }

        const randomIndex = Math.floor(Math.random() * students.length);
        const selectedStudent = students[randomIndex];

        let elementId = null;
        if (lessonId) {
          const drawRes = await ctx.commandBus.execute({
            id: 'int_' + Math.random().toString(36).slice(2),
            type: 'whiteboard.draw',
            payload: {
              lessonId,
              type: 'rollcall',
              data: JSON.stringify({
                classId,
                selectedStudent,
                allStudents: students,
                pickedTime: new Date().toISOString(),
                status: 'picked'
              })
            }
          });
          elementId = drawRes?.elementId;
        }

        return {
          success: true,
          selectedStudent,
          allStudentsCount: students.length,
          elementId,
          message: "已从当前班级中成功抽得幸运学生: " + selectedStudent.name
        };
      }
    });
  }
};`);
                  }}
                  className="px-2 py-1 text-[10px] uppercase font-bold text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700/80 rounded transition-all flex items-center gap-1 cursor-pointer"
                  title="Load custom random rollcall plugin source code"
                >
                  <Sparkles size={11} className="text-amber-400 animate-pulse" />
                  {lang === 'zh' ? '加载：随机点名助手' : 'Load Picker'}
                </button>
              </div>
            </div>

            {/* MigrationPrompt banner — shown when legacy plugins exist */}
            {hasLegacyPlugins && !dismissMigration && (
              <div className="px-4 pt-4 bg-gray-950">
                <MigrationPromptBanner />
              </div>
            )}

            {/* Split layout */}
            <div className="flex-1 flex overflow-hidden min-h-0 bg-gray-950">
              {/* Left Column: Code Editor */}
              <div className="w-7/12 flex flex-col border-r border-gray-800 h-full p-4 min-h-0">
                <div className="flex justify-between items-center mb-1 text-[10px] uppercase font-bold text-gray-400 select-none shrink-0">
                  <span>
                    {lang === 'zh'
                      ? '⚙️ 插件主程序 JS 源代码'
                      : '⚙️ Plugin Source Code (JavaScript)'}
                  </span>
                  <span className="font-mono text-[9px] text-gray-500">
                    Node Sandbox Ready
                  </span>
                </div>
                <textarea
                  value={pluginCode}
                  onChange={(e) => setPluginCode(e.target.value)}
                  className="w-full flex-1 font-mono text-[11px] p-4 bg-gray-900 border border-gray-800 text-indigo-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none leading-relaxed overflow-y-auto"
                />
              </div>

              {/* Right Column: Manifest Verification & Live Preview */}
              <div className="w-5/12 flex flex-col bg-gray-900/40 p-4 h-full overflow-y-auto min-h-0">
                <div className="mb-3">
                  <div className="text-[10px] uppercase font-bold text-gray-400 select-none mb-1.5 flex justify-between items-center">
                    <span>
                      {lang === 'zh'
                        ? '🔍 MANIFEST 实时解析与权限审计'
                        : '🔍 Manifest Extraction & Audit'}
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-400 border border-indigo-900 font-mono">
                      Live Static
                    </span>
                  </div>

                  {/* Status validation card */}
                  {(() => {
                    const parsed = parsePluginSource(pluginCode);
                    const hasManifest =
                      parsed && parsed.manifest && parsed.manifest.id && parsed.manifest.name;

                    return (
                      <div className="space-y-3.5">
                        {/* Verification Status Badge */}
                        <div
                          className={`p-3 rounded-lg border flex items-start gap-2 ${
                            hasManifest
                              ? 'bg-emerald-950/45 border-emerald-800/60 text-emerald-300'
                              : 'bg-amber-955/40 border-amber-800/60 text-amber-300'
                          }`}
                        >
                          {hasManifest ? (
                            <>
                              <CheckCircle2 size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                              <div>
                                <h5 className="text-xs font-bold font-sans">
                                  {lang === 'zh'
                                    ? '✓ Manifest 静态合法性验证通过'
                                    : '✓ Manifest Validation Passed'}
                                </h5>
                                <p className="text-[10px] text-emerald-400/80 mt-0.5 leading-tight">
                                  {lang === 'zh'
                                    ? '检测到完整的插件标识。可在安全白名单和命令总线中顺利完成挂载。'
                                    : 'Completed identifier extraction. Secure initialization is ready to deploy.'}
                                </p>
                              </div>
                            </>
                          ) : (
                            <>
                              <ShieldAlert size={16} className="text-amber-400 shrink-0 mt-0.5" />
                              <div>
                                <h5 className="text-xs font-bold font-sans">
                                  {lang === 'zh'
                                    ? '⚠️ 未匹配到有效 Manifest 描述符'
                                    : '⚠️ Searching for valid Metadata'}
                                </h5>
                                <p className="text-[10px] text-amber-400/80 mt-0.5 leading-tight">
                                  {lang === 'zh'
                                    ? '请在代码段中指定完整的 manifest 包含 id、name 属性，系统才能自动进行预览与权限挂载。'
                                    : 'Please provide manifest object inside exports.default with unique id/name properties to active automatic registration.'}
                                </p>
                              </div>
                            </>
                          )}
                        </div>

                        {/* Metadata Details */}
                        {hasManifest && parsed && parsed.manifest && (
                          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3.5 space-y-2.5">
                            <div className="border-b border-gray-800 pb-2 flex justify-between items-center">
                              <h6 className="text-[11px] font-bold text-gray-300 uppercase tracking-wider">
                                {lang === 'zh'
                                  ? '基本描述元数据'
                                  : 'Metadata Details'}
                              </h6>
                              <span className="text-[9px] text-indigo-400 font-mono px-1 bg-indigo-950 rounded">
                                v{parsed.manifest.version || '1.0.0'}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                              <div className="text-gray-500">
                                {lang === 'zh' ? '名称:' : 'Name:'}
                              </div>
                              <div className="col-span-2 text-gray-200 font-sans font-semibold">
                                {parsed.manifest.name}
                              </div>

                              <div className="text-gray-500">
                                {lang === 'zh' ? '唯一标识:' : 'UUID/ID:'}
                              </div>
                              <div className="col-span-2 text-gray-305">
                                {parsed.manifest.id}
                              </div>

                              <div className="text-gray-500">
                                {lang === 'zh' ? '开发者:' : 'Author:'}
                              </div>
                              <div className="col-span-2 text-indigo-305">
                                {parsed.manifest.author || 'Community'}
                              </div>
                            </div>
                            {parsed.manifest.description && (
                              <div className="text-[10.5px] text-gray-400 leading-relaxed bg-gray-950 border border-gray-900 p-2 rounded-md font-sans">
                                <span className="text-gray-550 float-left mr-1 font-bold">
                                  ℹ️
                                </span>
                                {parsed.manifest.description}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Requested Capabilities */}
                        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3.5 space-y-2">
                          <h6 className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider pb-1.5 border-b border-gray-800 flex items-center gap-1">
                            <Shield size={11} className="text-indigo-400" />
                            <span>
                              {lang === 'zh'
                                ? '申请所需扩展权限'
                                : 'Proposed Capabilities'}
                            </span>
                          </h6>
                          {parsed &&
                          parsed.manifest &&
                          parsed.manifest.capabilitiesProposed &&
                          parsed.manifest.capabilitiesProposed.length > 0 ? (
                            <div className="space-y-2">
                              {parsed.manifest.capabilitiesProposed.map(
                                (cap: string, idx: number) => {
                                  const normCap = cap.trim().toLowerCase();
                                  const info = CAPABILITY_INFO[normCap] || {
                                    labelZh: cap,
                                    labelEn: cap,
                                    iconName: 'Shield',
                                    risk: 'low' as const,
                                    riskDescZh:
                                      '自定义插件运行权限，具备常规沙箱网络与交互限制。',
                                    riskDescEn:
                                      'Custom plugin running capability under standard restraints.',
                                  };

                                  const riskConfig = {
                                    high: {
                                      bg: 'bg-red-950/20 border-red-900/40 hover:border-red-800/80 text-red-300',
                                      badge: 'bg-red-950/60 border-red-900/60 text-red-400',
                                      labelZh: '高风险',
                                      labelEn: 'High Risk',
                                      dot: 'bg-red-400',
                                    },
                                    medium: {
                                      bg: 'bg-amber-950/15 border-amber-900/30 hover:border-amber-800/65 text-amber-300',
                                      badge: 'bg-amber-950/60 border-amber-900/50 text-amber-400',
                                      labelZh: '中风险',
                                      labelEn: 'Medium Risk',
                                      dot: 'bg-amber-400',
                                    },
                                    low: {
                                      bg: 'bg-emerald-950/10 border-emerald-900/20 hover:border-emerald-800/40 text-emerald-400',
                                      badge: 'bg-emerald-950/50 border-emerald-900/40 text-emerald-400',
                                      labelZh: '低风险',
                                      labelEn: 'Low Risk',
                                      dot: 'bg-emerald-400',
                                    },
                                  }[info.risk];

                                  const renderIcon = () => {
                                    const iconClass = 'shrink-0 text-indigo-400';
                                    if (info.iconName === 'PenTool')
                                      return <PenTool className={iconClass} size={12} />;
                                    if (info.iconName === 'Eye')
                                      return <Eye className={iconClass} size={12} />;
                                    if (info.iconName === 'Users')
                                      return <Users className={iconClass} size={12} />;
                                    if (info.iconName === 'Database')
                                      return <Database className={iconClass} size={12} />;
                                    return <Shield className={iconClass} size={12} />;
                                  };

                                  return (
                                    <div
                                      key={idx}
                                      className={`p-2 rounded-lg border flex items-center justify-between gap-2.5 transition-all duration-200 group relative ${riskConfig.bg}`}
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className="p-1 rounded bg-gray-950 border border-gray-800 shrink-0">
                                          {renderIcon()}
                                        </span>
                                        <div className="min-w-0">
                                          <span className="text-[10.5px] font-bold text-gray-200 block truncate">
                                            {lang === 'zh'
                                              ? info.labelZh
                                              : info.labelEn}
                                          </span>
                                          <span className="text-[9px] text-gray-500 font-mono block truncate select-all">
                                            {cap}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Risk Badge with Floating Custom Interactive Tooltip */}
                                      <div className="relative shrink-0">
                                        <span
                                          className={`px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider border flex items-center gap-1 cursor-help transition-all ${riskConfig.badge}`}
                                        >
                                          <span
                                            className={`w-1 h-1 rounded-full animate-pulse ${riskConfig.dot}`}
                                          />
                                          <span>
                                            {lang === 'zh'
                                              ? riskConfig.labelZh
                                              : riskConfig.labelEn}
                                          </span>
                                        </span>

                                        {/* Floating hover card */}
                                        <div className="absolute z-55 right-0 bottom-full mb-2 w-56 p-2.5 bg-gray-950 border border-gray-800 rounded-lg shadow-xl text-left scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100 pointer-events-none transition-all duration-150 origin-bottom-right">
                                          <div className="flex items-center justify-between font-bold text-[9px] mb-1 pb-1 border-b border-gray-800 font-sans">
                                            <span className="text-gray-405 uppercase tracking-wide">
                                              {lang === 'zh'
                                                ? '安全性说明'
                                                : 'Security Audit'}
                                            </span>
                                            <span
                                              className={
                                                info.risk === 'high'
                                                  ? 'text-red-400'
                                                  : info.risk === 'medium'
                                                    ? 'text-amber-400'
                                                    : 'text-emerald-400'
                                              }
                                            >
                                              {lang === 'zh'
                                                ? riskConfig.labelZh
                                                : riskConfig.labelEn}
                                            </span>
                                          </div>
                                          <p className="text-[9.5px] leading-relaxed text-gray-300 font-sans">
                                            {lang === 'zh'
                                              ? info.riskDescZh
                                              : info.riskDescEn}
                                          </p>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                },
                              )}
                            </div>
                          ) : (
                            <div className="text-[10px] text-gray-500 italic py-1">
                              {lang === 'zh'
                                ? '无权限获取要求 (运行于无特权沙箱环境)'
                                : 'No additional capabilities requested.'}
                            </div>
                          )}
                        </div>

                        {/* Registered commands mapping */}
                        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3.5 space-y-2">
                          <h6 className="text-[11px] font-bold text-amber-300 uppercase tracking-wider pb-1.5 border-b border-gray-800 flex items-center gap-1">
                            <Terminal size={11} className="text-amber-400" />
                            <span>
                              {lang === 'zh'
                                ? '内核总线注册指令 (Commands)'
                                : 'Registered Commands'}
                            </span>
                          </h6>
                          {parsed &&
                          parsed.actions &&
                          parsed.actions.length > 0 ? (
                            <div className="space-y-2 max-h-48 overflow-y-auto">
                              {parsed.actions.map((act: any, idx: number) => (
                                <div
                                  key={idx}
                                  className="p-2 bg-gray-950 border border-gray-900 rounded-lg space-y-1"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-bold text-gray-300 font-mono">
                                      {act.id}
                                    </span>
                                    <span className="text-[9px] bg-amber-950 text-amber-400 border border-amber-900 rounded px-1.5 font-mono">
                                      {act.commandType}
                                    </span>
                                  </div>
                                  {act.description && (
                                    <p className="text-[9.5px] text-gray-400 leading-snug">
                                      {act.description}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-[10px] text-gray-500 italic py-1">
                              {lang === 'zh'
                                ? '未声明注册自定义指令句柄'
                                : 'No commands or command handlers detected.'}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Installed Plugins Management panel in Developer tools */}
                <div className="mt-5 bg-gray-900 border border-gray-800 rounded-xl p-3.5 space-y-3 shrink-0">
                  <h6 className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider pb-1.5 border-b border-gray-800 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Puzzle size={11} className="text-indigo-400 animate-pulse" />
                      <span>{lang === 'zh' ? `已加载插件管理 (${plugins.length})` : `Active Plugins (${plugins.length})`}</span>
                    </span>
                    <button 
                      onClick={() => setStoreTab('store')} 
                      className="text-[9px] text-gray-500 hover:text-indigo-400 transition-colors uppercase tracking-wider font-semibold"
                    >
                      {lang === 'zh' ? '管理大图 ➔' : 'View Grid ➔'}
                    </button>
                  </h6>
                  
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {plugins.length === 0 ? (
                      <div className="text-[10px] text-gray-550 italic py-2 text-center">
                        {lang === 'zh' ? '暂无安装的插件' : 'No plugins sideloaded.'}
                      </div>
                    ) : (
                      plugins.map((plugin) => (
                        <div key={plugin.id} className="p-2.5 bg-gray-950 border border-gray-900 rounded-lg flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-xs font-bold text-gray-200 truncate">{plugin.name}</span>
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${plugin.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}`} />
                            </div>
                            <span className="text-[10px] text-gray-500 font-mono block truncate select-all">{plugin.id}</span>
                          </div>
                          
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => onToggle(plugin.id)}
                              className={`px-2.5 py-1 text-[10px] font-bold rounded transition-colors ${
                                plugin.status === 'active'
                                  ? 'bg-amber-950/60 border border-amber-900/50 text-amber-400 hover:bg-amber-900/80'
                                  : 'bg-emerald-950/60 border border-emerald-900/50 text-emerald-400 hover:bg-emerald-900/80'
                              }`}
                            >
                              {plugin.status === 'active' ? (lang === 'zh' ? '禁用' : 'Disable') : (lang === 'zh' ? '启用' : 'Enable')}
                            </button>
                            {!plugin.id.startsWith('@openlearn/') && (
                              <>
                                <button
                                  onClick={() => {
                                    setUpdateTargetPluginId(plugin.id);
                                    updateFileInputRef.current?.click();
                                  }}
                                  className="px-2 py-1 text-[10px] font-bold bg-sky-950/60 border border-sky-900/50 text-sky-300 hover:bg-sky-900/80 rounded transition-colors"
                                >
                                  {lang === 'zh' ? '更新' : 'Update'}
                                </button>
                                <button
                                  onClick={() => onDelete(plugin.id)}
                                  className="px-2 py-1 text-[10px] font-bold bg-red-950/60 border border-red-900/50 text-red-400 hover:bg-red-900/80 rounded transition-colors"
                                >
                                  {lang === 'zh' ? '删除' : 'Delete'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Control actions footer */}
            <div className="p-4 border-t border-gray-800 bg-gray-950 flex justify-between items-center shrink-0 select-none">
              <span className="text-[10px] text-gray-500 font-mono">
                Secure Sideload Mode &bull; Sandbox Integrity Check
              </span>
              <div className="flex justify-end gap-3">
                <button
                  onClick={onInstall}
                  disabled={installingPlugin || !pluginCode.trim()}
                  className="px-4 py-2 text-xs bg-indigo-600 font-bold hover:bg-indigo-700 text-white rounded-lg transition-all flex items-center gap-2 disabled:opacity-50 hover:shadow-lg active:scale-97 cursor-pointer"
                >
                  {installingPlugin ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      <span>
                        {lang === 'zh' ? '集成挂载中...' : 'Registering...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={13} />
                      <span>
                        {lang === 'zh'
                          ? '部署并安装到课堂内核'
                          : 'Deploy & Install Plugin'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* V3.1: Plugin Settings Modal */}
    {settingsPlugin && (
      <PluginSettingsModal
        pluginId={settingsPlugin.id}
        pluginName={settingsPlugin.name}
        manifestStr={settingsPlugin.manifest}
        lang={lang}
        onClose={() => setSettingsPlugin(null)}
      />
    )}

    {/* V3.2: Plugin Install Wizard */}
    <PluginInstallWizard
      isOpen={!!selectedZipFile}
      onClose={() => {
        setSelectedZipFile(null);
        setUpdateTargetPluginId(null);
      }}
      lang={lang}
      file={selectedZipFile}
      lockedTargetPluginId={updateTargetPluginId}
      installedPlugins={plugins}
      onConfirmInstall={onZipUpload}
    />

    {/* V3.3: Release Notes & Changelog Modal */}
    {changelogModalPlugin && (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-gray-100 flex flex-col gap-4 animate-in fade-in zoom-in-95">
          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="text-indigo-600" size={20} />
              <h3 className="text-base font-bold text-gray-900">
                {changelogModalPlugin.name} {lang === 'zh' ? '版本更新说明' : 'Release Notes'}
              </h3>
            </div>
            <button
              onClick={() => setChangelogModalPlugin(null)}
              className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex items-center justify-between bg-indigo-50/70 border border-indigo-100 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold bg-white text-gray-600 px-2 py-0.5 rounded border border-gray-200">
                v{changelogModalPlugin.version || '1.1.0'}
              </span>
              <span className="text-indigo-400 font-bold">➔</span>
              <span className="text-xs font-mono font-bold bg-indigo-600 text-white px-2 py-0.5 rounded shadow-sm">
                v{changelogModalPlugin.marketItem?.latestVersion || '1.2.0'}
              </span>
              {changelogModalPlugin.marketItem?.isPrerelease && (
                <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                  {lang === 'zh' ? '预发布' : 'Pre-release'}
                </span>
              )}
            </div>
            {changelogModalPlugin.marketItem?.repository && (
              <a
                href={changelogModalPlugin.marketItem.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs font-mono text-indigo-600 hover:text-indigo-800 font-medium"
              >
                <Github size={12} />
                <span>Git Repo</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider">
              {lang === 'zh' ? '新特性与优化变更清单 (Changelog)' : 'What\'s New'}
            </h4>
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3.5 text-xs text-slate-700 leading-relaxed font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
              {changelogModalPlugin.marketItem?.changelog || (lang === 'zh' ? '1. 阶段式任务逻辑与自动化测试增强\n2. 前端轻量化与高可用平滑升级' : '1. General enhancements and bug fixes')}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100">
            <button
              onClick={() => setChangelogModalPlugin(null)}
              className="px-4 py-2 text-xs font-medium rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
            >
              {lang === 'zh' ? '稍后再说' : 'Later'}
            </button>
            <button
              onClick={() => {
                const targetId = changelogModalPlugin.id;
                const mItem = changelogModalPlugin.marketItem;
                setChangelogModalPlugin(null);
                handleOneClickUpdate(targetId, mItem);
              }}
              className="px-4 py-2 text-xs font-bold rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-md transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <span>🚀 {lang === 'zh' ? '立即一键热更新' : 'Update Now'}</span>
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Toast notification for One-Click update */}
    {updateToast && (
      <div className="fixed bottom-6 right-6 z-50 bg-gray-900/90 backdrop-blur text-white text-xs font-medium px-4 py-3 rounded-xl shadow-2xl border border-gray-700/80 flex items-center gap-2 animate-in slide-in-from-bottom-5">
        <RefreshCw size={14} className="text-indigo-400 animate-spin" />
        <span>{updateToast}</span>
      </div>
    )}
  </>
  );
}
