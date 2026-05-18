/**
 * Settings modal — slim form post-M2.5.
 *
 * After M2.5 the heavy "Model Config Center" (capability-grouped lists,
 * per-row reorder/test/delete, fallback ordering) was promoted to its own
 * top-level page (`ModelCenter.tsx`). Settings now only carries the
 * cross-cutting toggles that don't fit the per-model surface:
 *
 *   • Auto-fallback / stream recovery toggles
 *   • "Re-open onboarding" entry point
 *   • Danger zone (wipe SQLite + Keychain)
 *
 * Provider list / model matrix / connection test all live in Model Center.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type { StructuredMemory } from './api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { EmptyState } from './EmptyState.js';
import { StatusNotice } from './StatusNotice.js';
import type {
  BackupConflictStrategy,
  McpServer,
  McpServerRuntimeResponse,
  Persona,
  PromptTemplate,
  Tool,
  ToolHealthRow,
  WorkflowRecipe,
} from '@taori/shared';

const MAX_BACKUP_IMPORT_BYTES = 25 * 1024 * 1024;
const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 300_000;
const MANAGED_BOCHA_COMMAND = '__taori_managed_bocha__';
const MANAGED_BOCHA_KIND = 'bocha-search';
const MANAGED_MCP_KIND_ENV_KEY = 'TAORI_MANAGED_MCP_KIND';
const MANAGED_BOCHA_API_KEY_ENV = 'BOCHA_API_KEY';
const DEFAULT_SEARCH_TOOL = 'builtin.web_search';
const BUILTIN_WEB_SEARCH_ENGINE_KEY = 'builtin_web_search_engine';
const BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY = 'builtin_web_search_bocha_api_key';
type BuiltinSearchEngine = 'duckduckgo' | 'exa' | 'bocha';
type ToolsPane = 'search' | 'builtin' | 'mcp';

interface SettingsProps {
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onReopenOnboarding: () => void;
}

type SettingsTab = 'general' | 'tools' | 'prompts';

export function Settings({
  onClose,
  onChanged,
  onReopenOnboarding,
}: SettingsProps): JSX.Element {
  // Escape closes the modal — standard a11y expectation (WCAG 2.1.1).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="settings-overlay"
      data-testid="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-modal" role="dialog" aria-label="设置">
        <header className="settings-header">
          <h2>设置</h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <SettingsContent
          onChanged={onChanged}
          onReopenOnboarding={onReopenOnboarding}
        />
      </div>
    </div>
  );
}

export function SettingsContent({
  onChanged,
  onReopenOnboarding,
  fixedTab,
}: {
  onChanged: () => void | Promise<void>;
  onReopenOnboarding: () => void;
  fixedTab?: SettingsTab;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>(fixedTab ?? 'general');

  useEffect(() => {
    if (fixedTab) setActiveTab(fixedTab);
  }, [fixedTab]);

  return (
    <>
      {!fixedTab && (
        <nav className="settings-nav" aria-label="设置分组">
          {[
            ['general', '通用'],
            ['tools', '工具能力'],
            ['prompts', '提示词与 Persona'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={activeTab === id ? 'active' : ''}
              data-testid={`settings-tab-${id}`}
              onClick={() => setActiveTab(id as SettingsTab)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {activeTab === 'general' && (
        <GeneralTab onReopenOnboarding={onReopenOnboarding} onChanged={onChanged} />
      )}

      {activeTab === 'tools' && <ToolsSection onChanged={onChanged} />}

      {activeTab === 'prompts' && (
        <>
          <PromptTemplatesSection />
          <WorkflowRecipesSection />
          <PersonasSection />
        </>
      )}
    </>
  );
}

function notifyPromptAssetsChanged(): void {
  window.dispatchEvent(new Event('taori:prompt-assets-changed'));
}

function recipeVariables(content: string): Array<{ name: string; label: string; required: boolean }> {
  const names = new Set<string>();
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    const name = match[1]?.trim();
    if (name) names.add(name);
  }
  return [...names].map((name) => ({ name, label: name, required: true }));
}

function notifyBudgetSettingsChanged(): void {
  window.dispatchEvent(new Event('taori:budget-settings-changed'));
}

function notifyStreamRecoverySettingsChanged(): void {
  window.dispatchEvent(new Event('taori:stream-recovery-settings-changed'));
}

function ToolsSection({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolHealthRows, setToolHealthRows] = useState<Map<string, ToolHealthRow>>(new Map());
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpName, setMcpName] = useState('');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpArgs, setMcpArgs] = useState('');
  const [mcpEnv, setMcpEnv] = useState('');
  const [bochaApiKey, setBochaApiKey] = useState('');
  const [builtinSearchEngine, setBuiltinSearchEngine] = useState<BuiltinSearchEngine>('duckduckgo');
  const [defaultSearchToolName, setDefaultSearchToolName] = useState(DEFAULT_SEARCH_TOOL);
  const [imageTimeoutMinutes, setImageTimeoutMinutes] = useState('5');
  const [expandedMcpId, setExpandedMcpId] = useState<string | null>(null);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCommand, setEditCommand] = useState('');
  const [editArgs, setEditArgs] = useState('');
  const [editEnv, setEditEnv] = useState('');
  const [mcpRuntimeById, setMcpRuntimeById] = useState<Record<string, McpServerRuntimeResponse>>({});
  const [searchStatus, setSearchStatus] = useState<{ tone: 'success' | 'error' | 'loading'; title: string; detail: string } | null>(null);
  const [bochaStatus, setBochaStatus] = useState<{ tone: 'success' | 'error'; title: string; detail: string } | null>(null);
  const [activeToolsPane, setActiveToolsPane] = useState<ToolsPane>('search');
  const [toolsConfirm, setToolsConfirm] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const searchSectionRef = useRef<HTMLDivElement | null>(null);
  const builtinSectionRef = useRef<HTMLDivElement | null>(null);
  const mcpSectionRef = useRef<HTMLDivElement | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [res, healthRes, mcpRes, imageTimeoutRes, defaultSearchToolRes, builtinEngineRes, builtinBochaRes] = await Promise.all([
        api.listTools(),
        api.toolsHealth().catch(() => ({ rows: [] })),
        api.listMcpServers().catch(() => ({ servers: [] })),
        api.getMemoryEffective('image_generation_timeout_ms').catch(() => ({ data: { value: null as string | null } })),
        api.getMemoryEffective('default_search_tool').catch(() => ({ data: { value: null as string | null } })),
        api.getMemoryEffective(BUILTIN_WEB_SEARCH_ENGINE_KEY).catch(() => ({ data: { value: null as string | null } })),
        api.getMemoryEffective(BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY).catch(() => ({ data: { value: null as string | null } })),
      ]);
      setTools(res.data);
      setToolHealthRows(new Map(healthRes.rows.map((row) => [row.tool_name, row])));
      setMcpServers(mcpRes.servers);
      const bochaServer = mcpRes.servers.find(isManagedBochaServer);
      setBochaApiKey(builtinBochaRes.data.value ?? bochaServer?.env[MANAGED_BOCHA_API_KEY_ENV] ?? '');
      setBuiltinSearchEngine(
        builtinEngineRes.data.value === 'exa' || builtinEngineRes.data.value === 'bocha'
          ? builtinEngineRes.data.value
          : 'duckduckgo',
      );
      setDefaultSearchToolName(defaultSearchToolRes.data.value ?? DEFAULT_SEARCH_TOOL);
      const timeoutMs = Number(imageTimeoutRes.data.value ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS);
      const normalizedTimeoutMs =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
      setImageTimeoutMinutes(String(normalizedTimeoutMs / 60_000));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const bochaServer = mcpServers.find(isManagedBochaServer) ?? null;
  const customMcpServers = mcpServers.filter((server) => !isManagedBochaServer(server));
  const searchToolOptions = tools.filter(isSearchToolCandidate);
  const builtinSearchTool = tools.find((tool) => tool.name === 'builtin.web_search') ?? null;
  const builtinNonSearchTools = tools.filter(
    (tool) => tool.source === 'builtin' && !isSearchToolCandidate(tool),
  );
  const selectedSearchTool =
    defaultSearchToolName === DEFAULT_SEARCH_TOOL
      ? builtinSearchTool
      : searchToolOptions.find((tool) => tool.name === defaultSearchToolName) ?? null;
  const activeSearchLabel =
    defaultSearchToolName === DEFAULT_SEARCH_TOOL
      ? `内置网页搜索（${builtinSearchEngineLabel(builtinSearchEngine)}）`
      : selectedSearchTool
        ? searchToolOptionLabel(selectedSearchTool, mcpServers)
        : defaultSearchToolName;
  const scrollToToolsPane = (pane: ToolsPane): void => {
    setActiveToolsPane(pane);
    const target =
      pane === 'builtin'
        ? builtinSectionRef.current
        : pane === 'mcp'
          ? mcpSectionRef.current
          : searchSectionRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggle = async (tool: Tool): Promise<void> => {
    setSaving(tool.name);
    setError(null);
    try {
      const res = await api.setToolEnabled(tool.name, !tool.enabled);
      setTools((prev) => prev.map((item) => (item.name === tool.name ? res.data : item)));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const addMcpServer = async (): Promise<void> => {
    if (!mcpCommand.trim()) {
      setError('请输入 MCP server command。');
      return;
    }
    setSaving('mcp:add');
    setError(null);
    try {
      const created = await api.createMcpServer({
        name: mcpName.trim() || mcpCommand.trim(),
        command: mcpCommand.trim(),
        args: parseArgsText(mcpArgs),
        env: parseEnvText(mcpEnv),
        enabled: true,
      });
      await api.refreshMcpServer(created.server.id);
      setMcpName('');
      setMcpCommand('');
      setMcpArgs('');
      setMcpEnv('');
      await load();
      await loadMcpRuntime(created.server.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const saveBochaConfig = async (): Promise<void> => {
    const trimmedKey = bochaApiKey.trim();
    if (!trimmedKey) {
      setError('请先填写搏查 API Key。');
      return;
    }
    setSaving('bocha:save');
    setError(null);
    setBochaStatus(null);
    try {
      await api.putMemory('global', BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY, trimmedKey);
      let targetId: string | null = bochaServer?.id ?? null;
      if (bochaServer) {
        await api.updateMcpServer(bochaServer.id, buildManagedBochaServerPayload(trimmedKey));
      } else {
        const created = await api.createMcpServer(buildManagedBochaServerPayload(trimmedKey));
        targetId = created.server.id;
      }
      const refreshed = targetId ? await api.refreshMcpServer(targetId) : null;
      await load();
      if (refreshed?.ok) {
        setBochaStatus({
          tone: 'success',
          title: '搏查 MCP 已连接',
          detail: `检查成功，已发现 ${refreshed.tools.length} 个工具。`,
        });
      } else if (refreshed) {
        setBochaStatus({
          tone: 'error',
          title: '搏查 MCP 连接失败',
          detail: refreshed.server.last_error ?? '刷新后未返回可用工具。',
        });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBochaStatus({
        tone: 'error',
        title: '搏查 MCP 连接失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(null);
    }
  };

  const saveSearchConfig = async (): Promise<void> => {
    setSaving('search:engine');
    setError(null);
    setSearchStatus(null);
    try {
      const trimmedBochaKey = bochaApiKey.trim();
      await api.putMemory('global', BUILTIN_WEB_SEARCH_ENGINE_KEY, builtinSearchEngine);
      if (builtinSearchEngine === 'bocha') {
        if (!trimmedBochaKey) {
          throw new Error('搏查搜索需要 API Key。');
        }
      }
      if (trimmedBochaKey) {
        await api.putMemory('global', BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY, trimmedBochaKey);
      }
      if (!defaultSearchToolName || defaultSearchToolName === DEFAULT_SEARCH_TOOL) {
        await api.deleteMemory('global', 'default_search_tool');
      } else {
        await api.putMemory('global', 'default_search_tool', defaultSearchToolName);
      }
      setSearchStatus({
        tone: 'success',
        title: '搜索设置已保存',
        detail: `当前默认搜索：${activeSearchLabel}。`,
      });
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setSearchStatus({
        tone: 'error',
        title: '搜索设置保存失败',
        detail: message,
      });
    } finally {
      setSaving(null);
    }
  };

  const testBuiltinSearchConnection = async (): Promise<void> => {
    if (builtinSearchEngine === 'bocha' && !bochaApiKey.trim()) {
      setError('搏查搜索需要 API Key。');
      setSearchStatus({
        tone: 'error',
        title: '无法检查连接',
        detail: '请先填写搏查 API Key。',
      });
      return;
    }
    setSaving('search:test');
    setError(null);
    setSearchStatus({
      tone: 'loading',
      title: '正在检查内置搜索连接…',
      detail: `使用 ${builtinSearchEngineLabel(builtinSearchEngine)} 发起测试查询。`,
    });
    try {
      const trimmedBochaKey = bochaApiKey.trim();
      await api.putMemory('global', BUILTIN_WEB_SEARCH_ENGINE_KEY, builtinSearchEngine);
      if (builtinSearchEngine === 'bocha') {
        await api.putMemory('global', BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY, trimmedBochaKey);
      } else if (trimmedBochaKey) {
        await api.putMemory('global', BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY, trimmedBochaKey);
      }
      const res = await api.invokeTool('builtin.web_search', {
        query: 'Taori 搜索连接测试',
        num_results: 3,
      });
      if (!res.data.ok) {
        throw new Error(res.data.error?.message ?? '连接检查失败');
      }
      const output = res.data.output as { engine?: string; results?: Array<unknown> };
      setSearchStatus({
        tone: 'success',
        title: '内置搜索可用',
        detail: `${builtinSearchEngineLabel(builtinSearchEngine)} 已返回 ${output.results?.length ?? 0} 条结果。`,
      });
      await load();
      onChanged();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setSearchStatus({
        tone: 'error',
        title: '内置搜索不可用',
        detail: message,
      });
    } finally {
      setSaving(null);
    }
  };

  const toggleMcpServer = async (server: McpServer): Promise<void> => {
    setSaving(server.id);
    setError(null);
    try {
      await api.updateMcpServer(server.id, { enabled: !server.enabled });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const refreshMcpServer = async (server: McpServer): Promise<void> => {
    setSaving(`${server.id}:refresh`);
    setError(null);
    if (isManagedBochaServer(server)) setBochaStatus(null);
    try {
      const refreshed = await api.refreshMcpServer(server.id);
      await load();
      await loadMcpRuntime(server.id);
      if (isManagedBochaServer(server)) {
        setBochaStatus(refreshed.ok
          ? {
              tone: 'success',
              title: '搏查 MCP 可用',
              detail: `检查成功，已发现 ${refreshed.tools.length} 个工具。`,
            }
          : {
              tone: 'error',
              title: '搏查 MCP 不可用',
              detail: refreshed.server.last_error ?? '未返回可用工具。',
            });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (isManagedBochaServer(server)) {
        setBochaStatus({
          tone: 'error',
          title: '搏查 MCP 不可用',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      setSaving(null);
    }
  };

  const deleteMcpServer = (server: McpServer): void => {
    setToolsConfirm({
      title: '删除 MCP Server',
      message: `删除 MCP Server “${server.name}”？`,
      onConfirm: () => {
        setToolsConfirm(null);
        setSaving(`${server.id}:delete`);
        setError(null);
        (async () => {
          try {
            await api.deleteMcpServer(server.id);
            setMcpRuntimeById((prev) => {
              const next = { ...prev };
              delete next[server.id];
              return next;
            });
            setExpandedMcpId((prev) => (prev === server.id ? null : prev));
            setEditingMcpId((prev) => (prev === server.id ? null : prev));
            await load();
            onChanged();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setSaving(null);
          }
        })();
      },
    });
  };

  const saveImageTimeout = async (): Promise<void> => {
    const trimmed = imageTimeoutMinutes.trim();
    const parsedMinutes = Number(trimmed);
    if (!trimmed) {
      setSaving('image-timeout');
      setError(null);
      try {
        await api.deleteMemory('global', 'image_generation_timeout_ms');
        setImageTimeoutMinutes(String(DEFAULT_IMAGE_GENERATION_TIMEOUT_MS / 60_000));
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(null);
      }
      return;
    }
    if (!Number.isFinite(parsedMinutes) || parsedMinutes < 0.5 || parsedMinutes > 30) {
      setError('图片生成超时请输入 0.5 到 30 分钟之间的数字。');
      return;
    }
    setSaving('image-timeout');
    setError(null);
    try {
      await api.putMemory(
        'global',
        'image_generation_timeout_ms',
        String(Math.round(parsedMinutes * 60_000)),
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const loadMcpRuntime = async (serverId: string): Promise<void> => {
    const runtime = await api.getMcpServerRuntime(serverId);
    setMcpRuntimeById((prev) => ({ ...prev, [serverId]: runtime }));
  };

  const restartMcpServer = async (server: McpServer): Promise<void> => {
    setSaving(`${server.id}:restart`);
    setError(null);
    try {
      await api.restartMcpServer(server.id);
      await load();
      await loadMcpRuntime(server.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const toggleMcpDetails = async (server: McpServer): Promise<void> => {
    if (expandedMcpId === server.id) {
      setExpandedMcpId(null);
      setEditingMcpId((prev) => (prev === server.id ? null : prev));
      return;
    }
    setExpandedMcpId(server.id);
    try {
      await loadMcpRuntime(server.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const startEditMcpServer = (server: McpServer): void => {
    setExpandedMcpId(server.id);
    setEditingMcpId(server.id);
    setEditName(server.name);
    setEditCommand(server.command);
    setEditArgs(formatArgsText(server.args));
    setEditEnv(formatEnvText(server.env));
  };

  const saveMcpServer = async (server: McpServer): Promise<void> => {
    setSaving(`${server.id}:save`);
    setError(null);
    try {
      await api.updateMcpServer(server.id, {
        name: editName.trim() || editCommand.trim() || server.name,
        command: editCommand.trim(),
        args: parseArgsText(editArgs),
        env: parseEnvText(editEnv),
      });
      setEditingMcpId(null);
      if (server.enabled) {
        await api.restartMcpServer(server.id);
      }
      await load();
      await loadMcpRuntime(server.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-tools">
      <div className="settings-section-head">
        <h3>内置工具能力</h3>
      </div>
      <p className="hint">
        工具只会暴露给支持 tool/function calling 的聊天模型。图像生成会自动调用已配置的图像模型；图像理解不是独立工具，
        而是根据附件自动切换到支持视觉的聊天模型。
      </p>
      {loading ? (
        <StatusNotice
          tone="loading"
          title="加载工具列表…"
          detail="正在读取当前启用的内置工具与 MCP 工具状态。"
          compact
          testId="settings-tools-loading"
        />
      ) : (
        <>
          <div className="settings-tools-shell">
            <nav className="settings-tools-nav" aria-label="工具能力导航">
              {[
                ['search', '搜索'],
                ['builtin', '内置工具'],
                ['mcp', 'MCP'],
              ].map(([pane, label]) => (
                <button
                  key={pane}
                  type="button"
                  className={activeToolsPane === pane ? 'settings-tools-nav-btn active' : 'settings-tools-nav-btn'}
                  onClick={() => scrollToToolsPane(pane as ToolsPane)}
                  data-testid={`settings-tools-nav-${pane}`}
                >
                  {label}
                </button>
              ))}
            </nav>

            <div className="settings-tools-content">
              <div
                ref={searchSectionRef}
                className="settings-tools-panel"
                data-testid="settings-search-tools"
              >
                <div className="settings-section-head">
                  <h3>搜索</h3>
                </div>
                <p className="hint">
                  聊天、Quick Compare、Roundtable 与深度研究共用这里的搜索入口。默认搜索来源、内置引擎与搏查凭据统一收敛在这一组里。
                </p>
                <div className="settings-tool-list">
                  <article className="settings-tool-card" data-testid="settings-search-builtin">
                    <div data-testid="settings-tool-builtin.web_search">
                      <div className="settings-tool-title">
                        <strong>默认搜索入口</strong>
                        <code>builtin.web_search / default_search_tool</code>
                      </div>
                      <p>{builtinSearchTool ? toolDescription(builtinSearchTool) : '支持 DuckDuckGo / Exa / 搏查 三种内置搜索引擎。'}</p>
                      <div className="settings-inline-form settings-inline-form--stack">
                        <label className="settings-tools-field">
                          <span>默认搜索来源</span>
                          <select
                            value={defaultSearchToolName}
                            onChange={(e) => setDefaultSearchToolName(e.target.value)}
                            data-testid="settings-default-search-tool"
                          >
                            <option value={DEFAULT_SEARCH_TOOL}>
                              {`内置网页搜索（${builtinSearchEngineLabel(builtinSearchEngine)}）`}
                            </option>
                            {searchToolOptions
                              .filter((tool) => tool.name !== DEFAULT_SEARCH_TOOL)
                              .map((tool) => (
                                <option key={tool.name} value={tool.name}>
                                  {searchToolOptionLabel(tool, mcpServers)}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="settings-tools-field">
                          <span>内置引擎</span>
                          <select
                            value={builtinSearchEngine}
                            onChange={(e) => setBuiltinSearchEngine(e.target.value as BuiltinSearchEngine)}
                            data-testid="settings-builtin-search-engine"
                          >
                            <option value="duckduckgo">DuckDuckGo（免费）</option>
                            <option value="exa">Exa</option>
                            <option value="bocha">搏查</option>
                          </select>
                        </label>
                        <div className="settings-tool-meta">
                          <span>当前默认：{activeSearchLabel}</span>
                          <span>内置状态：{builtinSearchTool?.enabled === false ? '已关闭' : '可用'}</span>
                          <span>适用：聊天 / Quick Compare / Roundtable / 深度研究</span>
                        </div>
                        {builtinSearchEngine === 'bocha' && !bochaApiKey.trim() ? (
                          <p className="hint">搏查 API Key 在下方“搏查共享凭据”里维护，保存前请先填写。</p>
                        ) : null}
                      </div>
                      {searchStatus ? (
                        <StatusNotice
                          tone={searchStatus.tone}
                          title={searchStatus.title}
                          detail={searchStatus.detail}
                          compact
                          testId="settings-builtin-search-status"
                        />
                      ) : null}
                      <ToolHealthStrip health={toolHealthRows.get('builtin.web_search') ?? null} />
                    </div>
                    <div className="settings-mcp-actions">
                      <button
                        type="button"
                        className="settings-action-btn settings-action-btn--primary"
                        onClick={() => void saveSearchConfig()}
                        disabled={saving === 'search:engine'}
                        data-testid="settings-builtin-search-save"
                      >
                        {saving === 'search:engine' ? '保存中…' : '保存搜索设置'}
                      </button>
                      <button
                        type="button"
                        className="settings-action-btn settings-action-btn--secondary"
                        onClick={() => void testBuiltinSearchConnection()}
                        disabled={saving === 'search:test' || builtinSearchTool?.enabled === false}
                        data-testid="settings-builtin-search-test"
                      >
                        {saving === 'search:test' ? '检查中…' : '检查内置搜索'}
                      </button>
                      {builtinSearchTool ? (
                        <button
                          type="button"
                          className={builtinSearchTool.enabled ? 'tool-toggle enabled' : 'tool-toggle'}
                          disabled={saving === builtinSearchTool.name}
                          data-testid={`tool-toggle-${builtinSearchTool.name}`}
                          onClick={() => void toggle(builtinSearchTool)}
                        >
                          {saving === builtinSearchTool.name ? '保存中…' : builtinSearchTool.enabled ? '已启用' : '已关闭'}
                        </button>
                      ) : null}
                    </div>
                  </article>

                  <article className="settings-tool-card" data-testid="settings-search-bocha">
                    <div>
                      <div className="settings-tool-title">
                        <strong>搏查搜索共享凭据</strong>
                        <code>Bocha API Key</code>
                      </div>
                      <p>
                        这里的 API Key 会同时用于内置搏查搜索，以及可选的搏查 MCP Bridge；不再需要在两个地方分别维护。下方连接检查只验证 MCP Bridge 是否联通，不代表内置搏查搜索一定可用。
                      </p>
                      <div className="settings-inline-form settings-inline-form--stack">
                        <input
                          type="password"
                          value={bochaApiKey}
                          onChange={(e) => setBochaApiKey(e.target.value)}
                          placeholder="输入搏查 API Key"
                          autoComplete="off"
                          data-testid="mcp-bocha-api-key"
                        />
                        <div className="settings-tool-meta">
                          <span>共享凭据：{bochaApiKey.trim() ? '已填写' : '未填写'}</span>
                          <span>Bridge 状态：{bochaServer ? (bochaServer.enabled ? mcpHealthLabel(bochaServer.health_status) : '已停用') : '未配置'}</span>
                          <span>Bridge 工具：{bochaServer?.tools_count ?? 0} 个</span>
                        </div>
                        {bochaStatus ? (
                          <StatusNotice
                            tone={bochaStatus.tone}
                            title={bochaStatus.title}
                            detail={bochaStatus.detail}
                            compact
                            testId="settings-bocha-status"
                          />
                        ) : null}
                        {bochaServer?.last_error ? <p className="err">{bochaServer.last_error}</p> : null}
                      </div>
                    </div>
                    <div className="settings-mcp-actions">
                      <button
                        type="button"
                        className="settings-action-btn settings-action-btn--primary"
                        onClick={() => void saveBochaConfig()}
                        disabled={saving === 'bocha:save'}
                        data-testid="mcp-bocha-save"
                      >
                        {saving === 'bocha:save' ? '保存中…' : bochaServer ? '更新 API Key' : '接入搏查'}
                      </button>
                      {bochaServer ? (
                        <>
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => void refreshMcpServer(bochaServer)}
                            disabled={saving === `${bochaServer.id}:refresh` || !bochaServer.enabled}
                            data-testid="mcp-bocha-refresh"
                          >
                            {saving === `${bochaServer.id}:refresh` ? '检查中…' : '检查 MCP Bridge'}
                          </button>
                          <button
                            type="button"
                            className={bochaServer.enabled ? 'tool-toggle enabled' : 'tool-toggle'}
                            onClick={() => void toggleMcpServer(bochaServer)}
                            disabled={saving === bochaServer.id}
                            data-testid="mcp-bocha-toggle"
                          >
                            {bochaServer.enabled ? '已启用' : '已停用'}
                          </button>
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => void deleteMcpServer(bochaServer)}
                            disabled={saving === `${bochaServer.id}:delete`}
                            data-testid="mcp-bocha-delete"
                          >
                            移除
                          </button>
                        </>
                      ) : null}
                    </div>
                  </article>
                </div>
              </div>

              <div ref={builtinSectionRef} className="settings-tools-panel">
                <div className="settings-section-head">
                  <h3>内置工具</h3>
                </div>
                <p className="hint">
                  除搜索外的常用内置工具集中放在这里，避免搜索设置与日常工具开关混在一起。
                </p>
                <div className="settings-tool-list">
                  {builtinNonSearchTools.map((tool) => (
                    <article className="settings-tool-card" key={tool.name} data-testid={`settings-tool-${tool.name}`}>
                      <div>
                        <div className="settings-tool-title">
                          <strong>{toolLabel(tool.name)}</strong>
                          <code>{tool.name}</code>
                        </div>
                        <p>{toolDescription(tool)}</p>
                        <div className="settings-tool-meta">
                          <span>能力：{capabilityLabel(tool.capability)}</span>
                          <span>来源：{tool.source === 'builtin' ? '内置' : 'MCP'}</span>
                        </div>
                        <ToolHealthStrip health={toolHealthRows.get(tool.name) ?? null} />
                      </div>
                      <button
                        type="button"
                        className={tool.enabled ? 'tool-toggle enabled' : 'tool-toggle'}
                        disabled={saving === tool.name || tool.source === 'mcp'}
                        data-testid={`tool-toggle-${tool.name}`}
                        onClick={() => void toggle(tool)}
                        title={tool.source === 'mcp' ? '请在 MCP Server 层启停' : undefined}
                      >
                        {saving === tool.name ? '保存中…' : tool.enabled ? '已启用' : '已关闭'}
                      </button>
                    </article>
                  ))}
                </div>

                <div className="settings-section-head">
                  <h3>图像生成</h3>
                </div>
                <p className="hint">
                  可配置图像生成工具的单次等待上限。留空会恢复默认值 5 分钟。
                </p>
                <div className="settings-inline-form">
                  <input
                    type="number"
                    min="0.5"
                    max="30"
                    step="0.5"
                    value={imageTimeoutMinutes}
                    onChange={(e) => setImageTimeoutMinutes(e.target.value)}
                    placeholder="5"
                    data-testid="settings-image-timeout-minutes"
                  />
                  <button
                    type="button"
                    className="settings-action-btn settings-action-btn--primary"
                    onClick={() => void saveImageTimeout()}
                    disabled={saving === 'image-timeout'}
                    data-testid="settings-image-timeout-save"
                  >
                    {saving === 'image-timeout' ? '保存中…' : '保存超时'}
                  </button>
                </div>
              </div>

              <div ref={mcpSectionRef} className="settings-tools-panel" data-testid="settings-mcp">
                <div className="settings-section-head">
                  <h3>高级 MCP</h3>
                </div>
                <p className="hint">
                  这里保留给本地 stdio server 或自定义 bridge。常用搜索接入请优先使用上面的“搜索”区。
                </p>
                <div className="settings-mcp-form">
                  <input
                    value={mcpName}
                    onChange={(e) => setMcpName(e.target.value)}
                    placeholder="名称，例如 Filesystem"
                    data-testid="mcp-server-name"
                  />
                  <input
                    value={mcpCommand}
                    onChange={(e) => setMcpCommand(e.target.value)}
                    placeholder="command，例如 node"
                    data-testid="mcp-server-command"
                  />
                  <input
                    value={mcpArgs}
                    onChange={(e) => setMcpArgs(e.target.value)}
                    placeholder="args，以空格分隔"
                    data-testid="mcp-server-args"
                  />
                  <textarea
                    value={mcpEnv}
                    onChange={(e) => setMcpEnv(e.target.value)}
                    placeholder={'环境变量，每行一个，例如\nAPI_KEY=xxx'}
                    data-testid="mcp-server-env"
                  />
                  <button
                    type="button"
                    className="settings-action-btn settings-action-btn--primary"
                    onClick={() => void addMcpServer()}
                    disabled={saving === 'mcp:add'}
                    data-testid="mcp-server-add"
                  >
                    {saving === 'mcp:add' ? '添加中…' : '添加并刷新'}
                  </button>
                </div>
                {customMcpServers.length === 0 ? (
                  <StatusNotice
                    tone="info"
                    title="尚未添加 MCP Server"
                    detail="当前可直接添加本地 stdio Server，也可接入自定义 bridge。搏查等常用搜索已单独归入上方搜索工具区。"
                    compact
                    testId="settings-mcp-empty"
                  />
                ) : (
                  <div className="settings-tool-list">
                    {customMcpServers.map((server) => (
                      <article className="settings-tool-card" key={server.id} data-testid={`mcp-server-${server.id}`}>
                        <div>
                          <div className="settings-tool-title">
                            <strong>{server.name}</strong>
                            <code>{server.command} {server.args.join(' ')}</code>
                          </div>
                          <div className="settings-tool-meta">
                            <span>状态：{server.enabled ? '启用' : '停用'}</span>
                            <span>健康：{mcpHealthLabel(server.health_status)}</span>
                            <span>工具：{server.tools_count} 个</span>
                            <span>环境变量：{Object.keys(server.env).length} 个</span>
                          </div>
                          {server.last_error && <p className="err">{server.last_error}</p>}
                          {expandedMcpId === server.id && (
                            <div className="settings-mcp-runtime" data-testid={`mcp-server-runtime-${server.id}`}>
                              {editingMcpId === server.id ? (
                                <div className="settings-inline-form settings-inline-form--stack">
                                  <input
                                    value={editName}
                                    onChange={(e) => setEditName(e.target.value)}
                                    placeholder="名称"
                                    data-testid={`mcp-server-edit-name-${server.id}`}
                                  />
                                  <input
                                    value={editCommand}
                                    onChange={(e) => setEditCommand(e.target.value)}
                                    placeholder="command"
                                    data-testid={`mcp-server-edit-command-${server.id}`}
                                  />
                                  <input
                                    value={editArgs}
                                    onChange={(e) => setEditArgs(e.target.value)}
                                    placeholder="args，以空格分隔"
                                    data-testid={`mcp-server-edit-args-${server.id}`}
                                  />
                                  <textarea
                                    value={editEnv}
                                    onChange={(e) => setEditEnv(e.target.value)}
                                    placeholder={'环境变量，每行一个，例如\nAPI_KEY=xxx'}
                                    data-testid={`mcp-server-edit-env-${server.id}`}
                                  />
                                  <div className="settings-mcp-actions">
                                    <button
                                      type="button"
                                      className="settings-action-btn settings-action-btn--primary"
                                      onClick={() => void saveMcpServer(server)}
                                      disabled={saving === `${server.id}:save`}
                                      data-testid={`mcp-server-save-${server.id}`}
                                    >
                                      {saving === `${server.id}:save` ? '保存中…' : '保存并重载'}
                                    </button>
                                    <button
                                      type="button"
                                      className="settings-action-btn settings-action-btn--secondary"
                                      onClick={() => setEditingMcpId(null)}
                                      data-testid={`mcp-server-cancel-${server.id}`}
                                    >
                                      取消
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <p className="hint">
                                    {mcpRuntimeById[server.id]?.session_running
                                      ? '当前会话正在运行，可直接查看最近 stderr / 生命周期日志。'
                                      : '当前没有活跃会话；点击“检查连接”或“重启”后会重新建立连接。'}
                                  </p>
                                  <div className="settings-mcp-runtime-grid">
                                    <div className="settings-mcp-panel" data-testid={`mcp-server-tools-${server.id}`}>
                                      <strong>已注册工具</strong>
                                      {mcpRuntimeById[server.id]?.tools.length ? (
                                        <ul>
                                          {mcpRuntimeById[server.id].tools.map((tool) => (
                                            <li key={tool.name}>
                                              <code>{tool.name}</code>
                                              <span>{tool.description}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <p className="hint">暂无工具，请先检查连接。</p>
                                      )}
                                    </div>
                                    <div className="settings-mcp-panel" data-testid={`mcp-server-logs-${server.id}`}>
                                      <strong>最近日志</strong>
                                      {mcpRuntimeById[server.id]?.logs.length ? (
                                        <ul className="settings-mcp-logs">
                                          {mcpRuntimeById[server.id].logs.slice(-8).map((entry, index) => (
                                            <li key={`${entry.ts}-${index}`} className={`level-${entry.level}`}>
                                              <span>{formatRelativeTime(entry.ts)}</span>
                                              <code>{entry.message}</code>
                                            </li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <p className="hint">暂无日志，连接后会显示启动 / stderr / 退出信息。</p>
                                      )}
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="settings-mcp-actions">
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => void toggleMcpDetails(server)}
                            data-testid={`mcp-server-details-${server.id}`}
                          >
                            {expandedMcpId === server.id ? '收起详情' : '查看详情'}
                          </button>
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => startEditMcpServer(server)}
                            data-testid={`mcp-server-edit-${server.id}`}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => void refreshMcpServer(server)}
                            disabled={saving === `${server.id}:refresh` || !server.enabled}
                            data-testid={`mcp-server-refresh-${server.id}`}
                          >
                            {saving === `${server.id}:refresh` ? '检查中…' : '检查连接'}
                          </button>
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => void restartMcpServer(server)}
                            disabled={saving === `${server.id}:restart` || !server.enabled}
                            data-testid={`mcp-server-restart-${server.id}`}
                          >
                            {saving === `${server.id}:restart` ? '重启中…' : '重启'}
                          </button>
                          <button
                            type="button"
                            className={server.enabled ? 'tool-toggle enabled' : 'tool-toggle'}
                            onClick={() => void toggleMcpServer(server)}
                            disabled={saving === server.id}
                            data-testid={`mcp-server-toggle-${server.id}`}
                          >
                            {server.enabled ? '已启用' : '已停用'}
                          </button>
                          <button
                            type="button"
                            className="settings-action-btn settings-action-btn--secondary"
                            onClick={() => void deleteMcpServer(server)}
                            disabled={saving === `${server.id}:delete`}
                            data-testid={`mcp-server-delete-${server.id}`}
                          >
                            删除
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      {error && (
        <StatusNotice
          tone="error"
          title="工具设置加载失败"
          detail={error}
          compact
          testId="settings-tools-error"
        />
      )}
      <ConfirmDialog
        open={toolsConfirm != null}
        title={toolsConfirm?.title ?? ''}
        message={toolsConfirm?.message ?? ''}
        danger
        confirmLabel="删除"
        onConfirm={toolsConfirm?.onConfirm ?? (() => {})}
        onCancel={() => setToolsConfirm(null)}
      />
    </section>
  );
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    'builtin.file_read': '文件读取',
    'builtin.file_search': '文件检索',
    'builtin.web_search': '网页搜索',
    'builtin.web_fetch': '网页抓取',
    'builtin.image_generate': '图像生成',
  };
  return labels[name] ?? name;
}

function isSearchToolCandidate(tool: Tool): boolean {
  if (tool.name === 'builtin.file_search') return false;
  if (/(^|[\s._-])ai_search([\s._-]|$)/i.test(tool.name)) return false;
  const haystack = `${tool.name} ${tool.description}`.toLowerCase();
  return tool.name === 'builtin.web_search' || /(^|[\s._-])search([\s._-]|$)|搜索|检索/.test(haystack);
}

function isManagedBochaServer(server: McpServer): boolean {
  return (
    server.command === MANAGED_BOCHA_COMMAND &&
    server.env[MANAGED_MCP_KIND_ENV_KEY] === MANAGED_BOCHA_KIND
  );
}

function builtinSearchEngineLabel(engine: BuiltinSearchEngine): string {
  if (engine === 'exa') return 'Exa';
  if (engine === 'bocha') return '搏查';
  return 'DuckDuckGo';
}

function buildManagedBochaServerPayload(apiKey: string): Pick<McpServer, 'name' | 'command' | 'args' | 'env' | 'enabled'> {
  return {
    name: '搏查搜索',
    command: MANAGED_BOCHA_COMMAND,
    args: [],
    env: {
      [MANAGED_MCP_KIND_ENV_KEY]: MANAGED_BOCHA_KIND,
      [MANAGED_BOCHA_API_KEY_ENV]: apiKey,
    },
    enabled: true,
  };
}

function searchToolOptionLabel(tool: Tool, mcpServers: McpServer[]): string {
  if (tool.name === DEFAULT_SEARCH_TOOL) return '内置网页搜索';
  if (tool.source === 'mcp' && tool.source_id) {
    const server = mcpServers.find((item) => item.id === tool.source_id);
    return server ? `${server.name} · ${tool.description}` : `MCP · ${tool.description}`;
  }
  return toolLabel(tool.name);
}

function parseArgsText(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvText(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) throw new Error(`环境变量格式无效：${line}`);
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return env;
}

function formatArgsText(args: string[]): string {
  return args.join(' ');
}

function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function mcpHealthLabel(status: McpServer['health_status']): string {
  const labels: Record<McpServer['health_status'], string> = {
    unknown: '未检查',
    ok: '正常',
    error: '异常',
    disabled: '已停用',
  };
  return labels[status];
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1_000))} 秒前`;
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
}

function toolDescription(tool: Tool): string {
  if (tool.name === 'builtin.web_search') return '搜索公开网页，适合最新信息、外部资料和跨站点调研。';
  if (tool.name === 'builtin.web_fetch') return '读取指定公开 URL，并转换为可读文本；默认阻止 localhost、内网地址和敏感端口。';
  if (tool.name === 'builtin.image_generate') return '当聊天模型判断需要生成图片时，自动转交给默认或最便宜的图像模型处理。';
  if (tool.name === 'builtin.file_read') return '读取已上传文件的文本内容；不接受任意本地路径。';
  if (tool.name === 'builtin.file_search') return '按问题检索已上传文件片段，减少长文件拖垮上下文。';
  return tool.description;
}

function capabilityLabel(capability: Tool['capability']): string {
  const labels: Record<Tool['capability'], string> = {
    image: '图像',
    file: '文件',
    web: '网页',
    code: '代码',
    mcp: 'MCP',
  };
  return labels[capability];
}

const TOOL_FAILURE_LABELS: Record<string, string> = {
  validation_error: '参数错误',
  tool_timeout: '工具超时',
  mcp_crashed: 'MCP 崩溃',
  permission_denied: '权限限制',
  rate_limit: '限速',
  quota: '额度',
  network: '网络',
  unknown: '未知',
};

function ToolHealthStrip({ health }: { health: ToolHealthRow | null }): JSX.Element {
  const row = health ?? {
    tool_name: '',
    calls_24h: 0,
    failures_24h: 0,
    avg_duration_ms: null,
    last_failure_at: null,
    last_failure_classification: null,
  };
  const failureText = row.last_failure_classification
    ? `${TOOL_FAILURE_LABELS[row.last_failure_classification] ?? row.last_failure_classification} · ${formatAgo(row.last_failure_at)}`
    : '无';
  return (
    <div className="tool-health-strip" data-testid="tool-health-strip">
      <span>
        <small>24h 调用</small>
        <strong data-testid="tool-health-calls">{row.calls_24h}</strong>
      </span>
      <span>
        <small>失败</small>
        <strong data-testid="tool-health-failures">{row.failures_24h}</strong>
      </span>
      <span>
        <small>平均耗时</small>
        <strong data-testid="tool-health-duration">{formatMetricMs(row.avg_duration_ms)}</strong>
      </span>
      <span>
        <small>最近失败</small>
        <strong data-testid="tool-health-last-failure">{failureText}</strong>
      </span>
    </div>
  );
}

function formatMetricMs(value: number | null): string {
  if (value == null) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatAgo(ts: number | null): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function MonthlyBudgetSection(): JSX.Element {
  const [value, setValue] = useState('');
  const [hardLimit, setHardLimit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [budgetRes, hardRes] = await Promise.all([
          api.getMemoryEffective('monthly_budget_usd'),
          api.getMemoryEffective('monthly_budget_hard_limit'),
        ]);
        if (!cancelled) {
          setValue(budgetRes.data.value ?? '');
          setHardLimit(hardRes.data.value === 'true');
        }
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (nextValue: string): Promise<void> => {
    const trimmed = nextValue.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setMsg('请输入大于 0 的 USD 金额，或清空以关闭预算。');
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    try {
      if (trimmed) {
        await api.putMemory('global', 'monthly_budget_usd', trimmed);
        await api.putMemory('global', 'monthly_budget_hard_limit', hardLimit ? 'true' : 'false');
      } else {
        await api.deleteMemory('global', 'monthly_budget_usd');
        await api.deleteMemory('global', 'monthly_budget_hard_limit');
      }
      await api.deleteMemory('global', 'monthly_budget_alert_state');
      setValue(trimmed);
      setMsg(
        trimmed
          ? hardLimit
            ? '月度硬上限已保存。超过后会阻止模型调用，直到你调整预算。'
            : '月度软预算已保存。阈值提醒将从本月重新计算。'
          : '已关闭月度软预算和硬上限。',
      );
      notifyBudgetSettingsChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-monthly-budget">
      <div className="settings-section-head">
        <h3>月度预算</h3>
      </div>
      <p className="hint">
        配置月度预算（USD）。软预算超过 100% 后继续发送前要求确认；硬上限会直接阻止模型调用，直到你调整预算。
      </p>
      <div className="settings-inline-form">
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如 20"
          disabled={loading || saving}
          data-testid="monthly-budget-input"
        />
        <button
          type="button"
          className="settings-action-btn settings-action-btn--primary"
          onClick={() => void save(value)}
          disabled={loading || saving}
          data-testid="monthly-budget-save"
        >
          {saving ? '保存中…' : '保存预算'}
        </button>
        <button
          type="button"
          className="settings-action-btn settings-action-btn--secondary"
          onClick={() => void save('')}
          disabled={loading || saving || value.trim().length === 0}
          data-testid="monthly-budget-clear"
        >
          清除
        </button>
      </div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={hardLimit}
          onChange={(e) => setHardLimit(e.target.checked)}
          disabled={loading || saving || value.trim().length === 0}
          data-testid="monthly-budget-hard-limit"
        />
        启用硬上限：超过预算后不允许继续确认绕过
      </label>
      {msg && <p className="hint" data-testid="monthly-budget-message">{msg}</p>}
    </section>
  );
}

function DailyBudgetSection(): JSX.Element {
  const [value, setValue] = useState('');
  const [hardLimit, setHardLimit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [budgetRes, hardRes] = await Promise.all([
          api.getMemoryEffective('daily_budget_usd'),
          api.getMemoryEffective('daily_budget_hard_limit'),
        ]);
        if (!cancelled) {
          setValue(budgetRes.data.value ?? '');
          setHardLimit(hardRes.data.value === 'true');
        }
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (nextValue: string): Promise<void> => {
    const trimmed = nextValue.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setMsg('请输入大于 0 的 USD 金额，或清空以关闭日预算。');
        return;
      }
    }
    setSaving(true);
    setMsg(null);
    try {
      if (trimmed) {
        await api.putMemory('global', 'daily_budget_usd', trimmed);
        await api.putMemory('global', 'daily_budget_hard_limit', hardLimit ? 'true' : 'false');
      } else {
        await api.deleteMemory('global', 'daily_budget_usd');
        await api.deleteMemory('global', 'daily_budget_hard_limit');
      }
      await api.deleteMemory('global', 'daily_budget_alert_state');
      setValue(trimmed);
      setMsg(
        trimmed
          ? hardLimit
            ? '日硬上限已保存。今天达到后会阻止模型调用，直到你调整预算。'
            : '日软预算已保存。阈值提醒将从今天重新计算。'
          : '已关闭日软预算和硬上限。',
      );
      notifyBudgetSettingsChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-daily-budget">
      <div className="settings-section-head">
        <h3>日预算</h3>
      </div>
      <p className="hint">
        配置每日预算（USD）。软预算达到 100% 后继续发送前要求确认；硬上限会直接阻止模型调用，直到次日或你调整预算。日预算与月度预算独立计算，更紧的窗口会先触发。
      </p>
      <div className="settings-inline-form">
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="例如 2"
          disabled={loading || saving}
          data-testid="daily-budget-input"
        />
        <button
          type="button"
          className="settings-action-btn settings-action-btn--primary"
          onClick={() => void save(value)}
          disabled={loading || saving}
          data-testid="daily-budget-save"
        >
          {saving ? '保存中…' : '保存预算'}
        </button>
        <button
          type="button"
          className="settings-action-btn settings-action-btn--secondary"
          onClick={() => void save('')}
          disabled={loading || saving || value.trim().length === 0}
          data-testid="daily-budget-clear"
        >
          清除
        </button>
      </div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={hardLimit}
          onChange={(e) => setHardLimit(e.target.checked)}
          disabled={loading || saving || value.trim().length === 0}
          data-testid="daily-budget-hard-limit"
        />
        启用硬上限：超过日预算后不允许继续确认绕过
      </label>
      {msg && <p className="hint" data-testid="daily-budget-message">{msg}</p>}
    </section>
  );
}

function MemoryDrawerSection(): JSX.Element {
  const [items, setItems] = useState<StructuredMemory[]>([]);
  const [autoExtract, setAutoExtract] = useState(false);
  const [retrievalEnabled, setRetrievalEnabled] = useState(true);
  const [localOnly, setLocalOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setMsg(null);
    try {
      const [list, auto, retrieval, localOnlyPref] = await Promise.all([
        api.listStructuredMemories({ includeDisabled: true, limit: 100 }),
        api.getMemoryEffective('memory_auto_extract_enabled'),
        api.getMemoryEffective('memory_retrieval_enabled'),
        api.getMemoryEffective('memory_local_only_enabled'),
      ]);
      setItems(list.data.memories);
      setAutoExtract(auto.data.value === 'true');
      setRetrievalEnabled(retrieval.data.value !== 'false');
      setLocalOnly(localOnlyPref.data.value === 'true');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveToggle = async (key: string, value: boolean): Promise<void> => {
    setMsg(null);
    try {
      await api.putMemory('global', key, value ? 'true' : 'false');
      if (key === 'memory_auto_extract_enabled') setAutoExtract(value);
      if (key === 'memory_retrieval_enabled') setRetrievalEnabled(value);
      if (key === 'memory_local_only_enabled') setLocalOnly(value);
      setMsg('记忆设置已保存。');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const setEnabled = async (memory: StructuredMemory, enabled: boolean): Promise<void> => {
    setBusyId(memory.id);
    try {
      const res = await api.setStructuredMemoryEnabled(memory.id, enabled);
      setItems((prev) => prev.map((item) => item.id === memory.id ? res.data : item));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (memory: StructuredMemory): Promise<void> => {
    setBusyId(memory.id);
    try {
      await api.deleteStructuredMemory(memory.id);
      setItems((prev) => prev.filter((item) => item.id !== memory.id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-memory-drawer">
      <div className="settings-section-head">
        <h3>长期记忆</h3>
        <button type="button" onClick={() => void load()} disabled={loading}>
          刷新
        </button>
      </div>
      <p className="hint">
        Taori 可以把明确有长期价值的偏好和项目事实沉淀为本地记忆。所有记忆都可查看、禁用和删除。
      </p>
      <div className="settings-list">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={autoExtract}
            onChange={(e) => void saveToggle('memory_auto_extract_enabled', e.target.checked)}
            data-testid="memory-auto-extract-toggle"
          />
          自动抽取长期记忆（使用已配置的便宜聊天模型）
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={retrievalEnabled}
            onChange={(e) => void saveToggle('memory_retrieval_enabled', e.target.checked)}
            data-testid="memory-retrieval-toggle"
          />
          回答时使用已启用记忆
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={localOnly}
            onChange={(e) => void saveToggle('memory_local_only_enabled', e.target.checked)}
            data-testid="memory-local-only-toggle"
          />
          本地优先记忆模式（记忆抽取只使用 Ollama 本地模型）
        </label>
      </div>
      {loading ? (
        <p className="hint">正在加载记忆…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="暂无长期记忆"
          hint="当你开启记忆并持续对话后，这里会逐步沉淀长期信息。"
          icon="🧠"
          compact
          tone="muted"
          testId="memory-empty"
        />
      ) : (
        <div className="settings-list" data-testid="memory-list">
          {items.map((memory) => (
            <div className="settings-row memory-row" key={memory.id} data-testid="memory-row">
              <div>
                <strong>{memoryTypeLabel(memory.type)}</strong>
                <p>{memory.content}</p>
                <small>
                  来源：{memory.source_conversation_id ?? '未知'}
                  {' · '}
                  最后使用：{formatAgo(memory.last_used_at)}
                </small>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={busyId === memory.id}
                  onClick={() => void setEnabled(memory, !memory.enabled)}
                  data-testid="memory-toggle-enabled"
                >
                  {memory.enabled ? '禁用' : '启用'}
                </button>
                <button
                  type="button"
                  disabled={busyId === memory.id}
                  onClick={() => void remove(memory)}
                  data-testid="memory-delete"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {msg && <p className="hint" data-testid="memory-message">{msg}</p>}
    </section>
  );
}

function memoryTypeLabel(type: StructuredMemory['type']): string {
  if (type === 'preference') return '偏好';
  if (type === 'project_fact') return '项目事实';
  if (type === 'profile') return '用户画像';
  return '其他';
}

function PromptTemplatesSection(): JSX.Element {
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const resetForm = (): void => {
    setEditingId(null);
    setName('');
    setDescription('');
    setContent('');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPromptTemplates();
      setItems(res.prompt_templates);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onSubmit = async (): Promise<void> => {
    if (!name.trim() || !content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api.updatePromptTemplate(editingId, {
          name: name.trim(),
          description: description.trim() || null,
          content: content.trim(),
        });
      } else {
        await api.createPromptTemplate({
          name: name.trim(),
          description: description.trim() || null,
          content: content.trim(),
        });
      }
      resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = (id: string): void => {
    setConfirmDialog({
      title: '删除 Prompt 模板',
      message: '确认删除这个 Prompt 模板？',
      onConfirm: () => {
        setConfirmDialog(null);
        (async () => {
          try {
            await api.deletePromptTemplate(id);
            if (editingId === id) resetForm();
            await load();
            notifyPromptAssetsChanged();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        })();
      },
    });
  };

  return (
    <section className="settings-section" data-testid="settings-prompt-templates">
      <div className="settings-section-head">
        <h3>Prompt 模板</h3>
      </div>
      <p className="hint">支持 <code>{'{{变量}}'}</code> 占位。套用到聊天输入框前会逐个填空。</p>
      <div className="settings-library-grid">
        <div className="settings-library-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="模板名称"
            data-testid="template-name-input"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            data-testid="template-description-input"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例如：请从 {{行业}} 的角度分析 {{问题}}。"
            rows={6}
            data-testid="template-content-input"
          />
          <div className="settings-inline-actions">
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={saving || !name.trim() || !content.trim()}
              data-testid="template-save"
            >
              {saving ? '保存中…' : editingId ? '更新模板' : '新增模板'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                disabled={saving}
                data-testid="template-cancel"
              >
                取消编辑
              </button>
            )}
          </div>
        </div>
        <div className="settings-library-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="hint">还没有模板。先建一个常用开场或分析框架。</p>
          ) : (
            items.map((item) => (
              <article
                key={item.id}
                className="settings-library-card"
                data-testid="template-card"
              >
                <div className="settings-library-card-head">
                  <strong>{item.name}</strong>
                  <span className="settings-inline-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setName(item.name);
                        setDescription(item.description ?? '');
                        setContent(item.content);
                      }}
                      data-testid="template-edit"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(item.id)}
                      data-testid="template-delete"
                    >
                      删除
                    </button>
                  </span>
                </div>
                {item.description && <p className="hint">{item.description}</p>}
                <pre className="settings-library-preview">{item.content}</pre>
              </article>
            ))
          )}
          {error && <p className="err">{error}</p>}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDialog != null}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger
        confirmLabel="删除"
        onConfirm={confirmDialog?.onConfirm ?? (() => {})}
        onCancel={() => setConfirmDialog(null)}
      />
    </section>
  );
}

function WorkflowRecipesSection(): JSX.Element {
  const [items, setItems] = useState<WorkflowRecipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [requiredTools, setRequiredTools] = useState('');
  const [optionalTools, setOptionalTools] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const resetForm = (): void => {
    setEditingId(null);
    setName('');
    setDescription('');
    setPrompt('');
    setRequiredTools('');
    setOptionalTools('');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listWorkflowRecipes();
      setItems(res.workflow_recipes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const splitTools = (raw: string): string[] =>
    raw.split(',').map((item) => item.trim()).filter(Boolean);

  const makeSpec = () => ({
    schema_version: 1 as const,
    name: name.trim(),
    description: description.trim() || null,
    prompt_template: prompt.trim(),
    variables: recipeVariables(prompt),
    recommended_task: 'general' as const,
    model_strategy: 'recommend' as const,
    persona: { mode: 'none' as const },
    tools: {
      required: splitTools(requiredTools),
      optional: splitTools(optionalTools),
    },
    output_format: { kind: 'markdown' as const, sections: [] },
    budget: { mode: 'none' as const },
    metadata: {},
  });

  const onSubmit = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        spec: makeSpec(),
        enabled: true,
      };
      if (editingId) {
        await api.updateWorkflowRecipe(editingId, payload);
      } else {
        await api.createWorkflowRecipe(payload);
      }
      resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = (id: string): void => {
    setConfirmDialog({
      title: '删除 Workflow Recipe',
      message: '确认删除这个 Workflow Recipe？',
      onConfirm: () => {
        setConfirmDialog(null);
        (async () => {
          try {
            await api.deleteWorkflowRecipe(id);
            if (editingId === id) resetForm();
            await load();
            notifyPromptAssetsChanged();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        })();
      },
    });
  };

  return (
    <section className="settings-section" data-testid="settings-workflow-recipes">
      <div className="settings-section-head">
        <h3>Workflow Recipe</h3>
      </div>
      <p className="hint">
        Recipe 会保存 Prompt、变量和工具建议；套用时只填充输入框，不自动执行多步骤流程。
      </p>
      <div className="settings-library-grid">
        <div className="settings-library-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Recipe 名称"
            data-testid="recipe-name-input"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            data-testid="recipe-description-input"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：请围绕 {{topic}} 输出结论、证据、风险和下一步。"
            rows={6}
            data-testid="recipe-prompt-input"
          />
          <input
            type="text"
            value={requiredTools}
            onChange={(e) => setRequiredTools(e.target.value)}
            placeholder="必需工具（逗号分隔，可选）"
            data-testid="recipe-required-tools-input"
          />
          <input
            type="text"
            value={optionalTools}
            onChange={(e) => setOptionalTools(e.target.value)}
            placeholder="可选工具（逗号分隔，可选）"
            data-testid="recipe-optional-tools-input"
          />
          <div className="settings-inline-actions">
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={saving || !name.trim() || !prompt.trim()}
              data-testid="recipe-save"
            >
              {saving ? '保存中…' : editingId ? '更新 Recipe' : '新增 Recipe'}
            </button>
            {editingId && (
              <button type="button" onClick={resetForm} disabled={saving} data-testid="recipe-cancel">
                取消编辑
              </button>
            )}
          </div>
        </div>
        <div className="settings-library-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="hint">还没有 Recipe。先把一个高频任务沉淀下来。</p>
          ) : (
            items.map((item) => (
              <article key={item.id} className="settings-library-card" data-testid="recipe-card">
                <div className="settings-library-card-head">
                  <strong>{item.name}</strong>
                  <span className="settings-inline-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setName(item.name);
                        setDescription(item.description ?? '');
                        setPrompt(item.spec.prompt_template);
                        setRequiredTools(item.spec.tools.required.join(', '));
                        setOptionalTools(item.spec.tools.optional.join(', '));
                      }}
                      data-testid="recipe-edit"
                    >
                      编辑
                    </button>
                    <button type="button" onClick={() => void onDelete(item.id)} data-testid="recipe-delete">
                      删除
                    </button>
                  </span>
                </div>
                {item.description && <p className="hint">{item.description}</p>}
                <pre className="settings-library-preview">{item.spec.prompt_template}</pre>
              </article>
            ))
          )}
          {error && <p className="err">{error}</p>}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDialog != null}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger
        confirmLabel="删除"
        onConfirm={confirmDialog?.onConfirm ?? (() => {})}
        onCancel={() => setConfirmDialog(null)}
      />
    </section>
  );
}

function PersonasSection(): JSX.Element {
  const [items, setItems] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const resetForm = (): void => {
    setEditingId(null);
    setName('');
    setDescription('');
    setPrompt('');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPersonas();
      setItems(res.personas);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const onSubmit = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await api.updatePersona(editingId, {
          name: name.trim(),
          description: description.trim() || null,
          prompt: prompt.trim(),
        });
      } else {
        await api.createPersona({
          name: name.trim(),
          description: description.trim() || null,
          prompt: prompt.trim(),
        });
      }
      resetForm();
      await load();
      notifyPromptAssetsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = (id: string): void => {
    setConfirmDialog({
      title: '删除 Persona',
      message: '确认删除这个 Persona？已绑定到会话的选择会自动失效。',
      onConfirm: () => {
        setConfirmDialog(null);
        (async () => {
          try {
            await api.deletePersona(id);
            if (editingId === id) resetForm();
            await load();
            notifyPromptAssetsChanged();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        })();
      },
    });
  };

  return (
    <section className="settings-section" data-testid="settings-personas">
      <div className="settings-section-head">
        <h3>Persona 预设</h3>
      </div>
      <p className="hint">
        Persona 会以 system prompt 注入，不会显示在消息时间线里。建议像内置 OpenClaw Persona 一样写清楚
        Core Truths / Voice / Operating Style / Boundaries / Anti-patterns；未创建会话时的选择会先显示为“待绑定”，发送首条消息后绑定到该会话。
      </p>
      <div className="settings-library-grid">
        <div className="settings-library-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Persona 名称"
            data-testid="persona-name-input"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            data-testid="persona-description-input"
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：你是一位严格的架构评审，优先指出边界、风险与回滚路径。"
            rows={6}
            data-testid="persona-prompt-input"
          />
          <div className="settings-inline-actions">
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={saving || !name.trim() || !prompt.trim()}
              data-testid="persona-save"
            >
              {saving ? '保存中…' : editingId ? '更新 Persona' : '新增 Persona'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                disabled={saving}
                data-testid="persona-cancel"
              >
                取消编辑
              </button>
            )}
          </div>
        </div>
        <div className="settings-library-list">
          {loading ? (
            <p className="hint">加载中…</p>
          ) : items.length === 0 ? (
            <p className="hint">还没有 Persona。先建一个常用角色口径。</p>
          ) : (
            items.map((item) => (
              <article
                key={item.id}
                className="settings-library-card"
                data-testid="persona-card"
              >
                <div className="settings-library-card-head">
                  <strong>{item.name}</strong>
                  <span className="settings-inline-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setName(item.name);
                        setDescription(item.description ?? '');
                        setPrompt(item.prompt);
                      }}
                      data-testid="persona-edit"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(item.id)}
                      data-testid="persona-delete"
                    >
                      删除
                    </button>
                  </span>
                </div>
                {item.description && <p className="hint">{item.description}</p>}
                <pre className="settings-library-preview">{item.prompt}</pre>
              </article>
            ))
          )}
          {error && <p className="err">{error}</p>}
        </div>
      </div>
      <ConfirmDialog
        open={confirmDialog != null}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger
        confirmLabel="删除"
        onConfirm={confirmDialog?.onConfirm ?? (() => {})}
        onCancel={() => setConfirmDialog(null)}
      />
    </section>
  );
}

/**
 * Danger zone (M1 §6.2): wipes SQLite + Keychain. We require two confirms:
 * a checkbox to unlock the button (so a stray click can't fire it) and a
 * custom ConfirmDialog with the explicit "无法恢复" wording. The endpoint
 * itself is destructive but idempotent — running it twice on an empty store
 * is a no-op.
 */
function DangerZone({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busyClear, setBusyClear] = useState(false);
  const [busyExport, setBusyExport] = useState(false);
  const [busyImport, setBusyImport] = useState(false);
  const [importStrategy, setImportStrategy] = useState<BackupConflictStrategy>('overwrite');
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function onClear(): void {
    if (!armed || busyClear || busyExport || busyImport) return;
    setConfirmDialog({
      title: '清空所有数据',
      message: '确定要清空所有数据吗？\n这会删除：所有会话、所有消息、所有模型与 Provider、所有 Keychain 中保存的 API Key。\n此操作无法恢复。',
      onConfirm: () => {
        setConfirmDialog(null);
        setBusyClear(true);
        setMsg(null);
        (async () => {
          try {
            const res = await api.clearAllData();
            const failures = res.data.keystore_failures.length;
            setMsg(
              failures > 0
                ? `已清空。Keychain 有 ${failures} 项删除失败，可手动到「钥匙串访问」清理。`
                : `已清空。Keychain 同步删除 ${res.data.keystore_entries_removed} 项。`,
            );
            onChanged();
          } catch (e) {
            setMsg(`清空失败：${e instanceof Error ? e.message : String(e)}`);
          } finally {
            setBusyClear(false);
            setArmed(false);
          }
        })();
      },
    });
  }

  async function onExport(): Promise<void> {
    if (busyClear || busyExport || busyImport) return;
    setBusyExport(true);
    setMsg(null);
    try {
      const res = await api.exportBackup();
      const filename = `taori_backup_${new Date(res.backup.exported_at).toISOString().replace(/[:.]/g, '-')}.json`;
      const blob = new Blob([JSON.stringify(res.backup, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setMsg(`备份已导出：${filename}。注意：API Key 不包含在备份中。`);
    } catch (e) {
      setMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyExport(false);
    }
  }

  async function onImportFile(file: File | null): Promise<void> {
    if (!file || busyClear || busyExport || busyImport) return;
    if (file.size > MAX_BACKUP_IMPORT_BYTES) {
      setMsg(`导入失败：备份文件超过 25MB，请拆分附件或使用更小的备份。`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setBusyImport(true);
    setMsg('正在读取并校验备份文件…');
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      setMsg('正在导入备份…');
      const res = await api.importBackup(importStrategy, backup);
      const importedCounts = Object.values(res.data.imported) as number[];
      const renamedCounts = Object.values(res.data.renamed) as number[];
      const totalImported = importedCounts.reduce((sum, value) => sum + value, 0);
      const totalRenamed = renamedCounts.reduce((sum, value) => sum + value, 0);
      const warningText =
        res.data.warnings.length > 0
          ? ` 警告 ${res.data.warnings.length} 条（例如：${res.data.warnings[0]}）。`
          : '';
      setMsg(
        `导入完成：新增/更新 ${totalImported} 项，重命名 ${totalRenamed} 项。${warningText}`,
      );
      await onChanged();
    } catch (e) {
      setMsg(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyImport(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <section className="settings-section settings-danger" data-testid="settings-danger-zone">
      <div className="settings-section-head">
        <h3>危险区 / Danger zone</h3>
      </div>
      <p className="hint">
        备份 / 恢复 / 清空全部数据都在这里。备份导出为单个 JSON；导入后会恢复会话、圆桌、模型配置、记忆、模板与 Persona。
        API Key 出于安全原因不会进入备份，恢复后需手动重新填写。
      </p>
      <div className="settings-inline-form">
        <button
          type="button"
          className="settings-action-btn settings-action-btn--secondary"
          onClick={() => void onExport()}
          disabled={busyClear || busyExport || busyImport}
          data-testid="settings-export-backup"
        >
          {busyExport ? '导出中…' : '导出全部数据'}
        </button>
        <select
          value={importStrategy}
          onChange={(e) => setImportStrategy(e.target.value as BackupConflictStrategy)}
          disabled={busyClear || busyExport || busyImport}
          data-testid="settings-import-strategy"
        >
          <option value="overwrite">导入策略：覆盖</option>
          <option value="skip">导入策略：跳过冲突</option>
          <option value="rename">导入策略：重命名冲突</option>
        </select>
        <button
          type="button"
          className="settings-action-btn settings-action-btn--secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={busyClear || busyExport || busyImport}
          data-testid="settings-import-backup"
        >
          {busyImport ? '导入中…' : '导入备份 JSON'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => void onImportFile(e.target.files?.[0] ?? null)}
          data-testid="settings-import-file"
        />
      </div>
      <p className="hint">
        “覆盖”会更新同 ID / 同 memory 键的数据；“跳过冲突”保留现有数据；“重命名冲突”会为可重命名的数据生成新 ID。
      </p>
      <label className="danger-arm">
        <input
          type="checkbox"
          checked={armed}
          onChange={(e) => setArmed(e.target.checked)}
          data-testid="settings-danger-arm"
        />
        我已知晓，确认要清空所有数据。
      </label>
      <button
        type="button"
        className="danger-btn"
        disabled={!armed || busyClear || busyExport || busyImport}
        onClick={() => void onClear()}
        data-testid="settings-clear-all"
      >
        {busyClear ? '清理中…' : '清空所有数据'}
      </button>
      {msg && <p className="hint" data-testid="settings-danger-msg">{msg}</p>}
      <ConfirmDialog
        open={confirmDialog != null}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger
        confirmLabel="清空"
        onConfirm={confirmDialog?.onConfirm ?? (() => {})}
        onCancel={() => setConfirmDialog(null)}
      />
    </section>
  );
}

// =====================================================================
// M2.1 — Auto-fallback toggle
// =====================================================================
//
// Persists the global `auto_fallback_enabled` flag via /v1/memories.
// The flag is read by the chat route per request and emitted in the
// `failure_decision` annotation; the renderer's auto-fallback effect
// in ChatPanel consumes it to fire a single-hop retry.
//
/** General tab — progressive disclosure layout. */
function GeneralTab({ onReopenOnboarding, onChanged }: { onReopenOnboarding: () => void; onChanged: () => void | Promise<void> }): JSX.Element {
  const [budgetScope, setBudgetScope] = useState<'monthly' | 'daily'>('monthly');

  return (
    <>
      <AutoFallbackSection />
      <details>
        <summary>回复中断恢复</summary>
        <StreamRecoverySection />
      </details>
      <details>
        <summary>模型思考</summary>
        <ThinkingSection />
      </details>
      <div className="settings-budget-combined">
        <div className="settings-budget-tabs">
          <button
            type="button"
            className={`settings-budget-tab${budgetScope === 'monthly' ? ' active' : ''}`}
            onClick={() => setBudgetScope('monthly')}
          >
            月度预算
          </button>
          <button
            type="button"
            className={`settings-budget-tab${budgetScope === 'daily' ? ' active' : ''}`}
            onClick={() => setBudgetScope('daily')}
          >
            日预算
          </button>
        </div>
        {budgetScope === 'monthly' ? <MonthlyBudgetSection /> : <DailyBudgetSection />}
      </div>
      <details>
        <summary>长期记忆</summary>
        <MemoryDrawerSection />
      </details>
      <section className="settings-section">
        <div className="settings-section-head">
          <h3>Provider 与模型</h3>
        </div>
        <p className="hint">
          模型与 Provider 的管理已迁移至独立的 <strong>模型中心</strong>。如需重新走一遍完整 Onboarding，可点击下方按钮。
        </p>
        <button
          type="button"
          className="settings-action-btn settings-action-btn--primary"
          onClick={onReopenOnboarding}
          data-testid="settings-add-provider"
        >
          重新打开 Onboarding
        </button>
      </section>
      <details>
        <summary>危险区</summary>
        <DangerZone
          onChanged={() => {
            onChanged();
          }}
        />
      </details>
    </>
  );
}

// We optimistically reflect the toggled value before the round-trip
// completes so users don't see a click-then-wait UX; on failure we
// revert and surface the error.
function AutoFallbackSection(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getMemoryEffective('auto_fallback_enabled');
        if (cancelled) return;
        setEnabled(r.data.value === 'true');
      } catch (e) {
        if (!cancelled) setEnabled(false);
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (): Promise<void> => {
    if (enabled == null || busy) return;
    const next = !enabled;
    setBusy(true);
    setErr(null);
    setEnabled(next);
    try {
      await api.putMemory('global', 'auto_fallback_enabled', String(next));
    } catch (e) {
      setEnabled(!next);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-auto-fallback">
      <h3>失败处理</h3>
      <label className="auto-fallback-row">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled == null || busy}
          onChange={() => void onToggle()}
          data-testid="auto-fallback-toggle"
        />
        <span className="auto-fallback-label">
          失败时自动切换到下一个备用模型重试（单次）
        </span>
      </label>
      <p className="hint">
        当上游返回额度/速率/网络类错误时，会按 fallback 顺序自动切换到下一个可用模型重试一次；
        内容策略错误（content_filter）始终不自动重试。
      </p>
      {err && <p className="err" data-testid="auto-fallback-err">{err}</p>}
    </section>
  );
}

function StreamRecoverySection(): JSX.Element {
  const [autoResume, setAutoResume] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getMemoryEffective('stream_auto_resume_enabled');
        if (cancelled) return;
        setAutoResume(r.data.value === 'true');
      } catch (e) {
        if (!cancelled) setAutoResume(false);
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggleAutoResume = async (): Promise<void> => {
    if (autoResume == null || busy) return;
    const next = !autoResume;
    setBusy(true);
    setErr(null);
    setAutoResume(next);
    try {
      await api.putMemory('global', 'stream_auto_resume_enabled', String(next));
      notifyStreamRecoverySettingsChanged();
    } catch (e) {
      setAutoResume(!next);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-stream-recovery">
      <h3>回复中断恢复</h3>
      <label className="auto-fallback-row">
        <input
          type="checkbox"
          checked={autoResume === true}
          disabled={autoResume == null || busy}
          onChange={() => void onToggleAutoResume()}
          data-testid="stream-auto-resume-toggle"
        />
        <span className="auto-fallback-label">
          网络或 SSE 中断后自动尝试续接未完成回复
        </span>
      </label>
      <p className="hint">
        默认关闭。开启后，Taori 会在检测到未完成 run 且 Sidecar 判断可续接时自动继续生成；
        无法安全判断时仍会保留“继续生成”按钮给你手动确认。
      </p>
      {err && <p className="err" data-testid="stream-recovery-err">{err}</p>}
    </section>
  );
}

function ThinkingSection(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getMemoryEffective('thinking_enabled');
        if (cancelled) return;
        setEnabled(r.data.value === 'true');
      } catch (e) {
        if (!cancelled) setEnabled(false);
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (): Promise<void> => {
    if (enabled == null || busy) return;
    const next = !enabled;
    setBusy(true);
    setErr(null);
    setEnabled(next);
    try {
      await api.putMemory('global', 'thinking_enabled', String(next));
    } catch (e) {
      setEnabled(!next);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-thinking">
      <h3>模型思考</h3>
      <label className="auto-fallback-row">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled == null || busy}
          onChange={() => void onToggle()}
          data-testid="thinking-toggle"
        />
        <span className="auto-fallback-label">
          默认开启模型思考 / 推理
        </span>
      </label>
      <p className="hint">
        这是全局默认值；模型中心里可对单个模型单独覆盖。不同 provider 对 thinking 的支持方式不同，
        Taori 会按已知兼容方式尽量适配。
      </p>
      {err && <p className="err" data-testid="thinking-err">{err}</p>}
    </section>
  );
}
