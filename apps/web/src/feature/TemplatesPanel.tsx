import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import {
  createPersona,
  createPromptTemplate,
  deletePersona,
  deletePromptTemplate,
  listPersonas,
  listPromptTemplates,
  type Persona,
  type PromptTemplate,
} from '../api';

interface TemplatesPanelProps {
  panelId?: string;
  onUsePromptTemplate?: (content: string) => void;
}

export function TemplatesPanel({ panelId, onUsePromptTemplate }: TemplatesPanelProps): JSX.Element {
  const toast = useToast();
  const dialog = useDialog();
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'templates' | 'personas'>('templates');
  const [expanded, setExpanded] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const [t, p] = await Promise.all([listPromptTemplates(), listPersonas()]);
      setTemplates(t);
      setPersonas(p);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addTemplate(): Promise<void> {
    const name = await dialog.prompt({
      title: '新建提示词模板',
      description: '取一个简短的名字，方便日后召唤。',
      placeholder: '比如：周报骨架',
      validate: (value) => (value.length < 1 ? '名字不能为空' : null),
    });
    if (!name) return;
    const content = await dialog.prompt({
      title: `「${name}」的正文`,
      description: '调用时这段内容会被注入到对话起点；后面再补就行，不必一次写完。',
      placeholder: '写下模板正文…',
      multiline: true,
      validate: (value) => (value.length < 1 ? '内容不能为空' : null),
    });
    if (!content) return;
    try {
      await createPromptTemplate({ name, content });
      toast.success('已新建模板。');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function addPersona(): Promise<void> {
    const name = await dialog.prompt({
      title: '新建人格',
      description: '人格 = 一段系统提示，用来定义助手的语气、判断与边界。',
      placeholder: '比如：合同律师',
      validate: (value) => (value.length < 1 ? '名字不能为空' : null),
    });
    if (!name) return;
    const prompt = await dialog.prompt({
      title: `「${name}」的人格描述`,
      description: '至少 8 个字。这是会被注入到每次对话开头的系统提示。',
      placeholder: '你是…',
      multiline: true,
      validate: (value) => (value.length < 8 ? '至少 8 个字' : null),
    });
    if (!prompt) return;
    try {
      await createPersona({ name, prompt });
      toast.success('已新建人格。');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeTemplate(item: PromptTemplate): Promise<void> {
    const confirmed = await dialog.confirm({
      title: `删除模板「${item.name}」？`,
      description: '此操作不可撤销。',
      tone: 'danger',
      okLabel: '删除',
    });
    if (!confirmed) return;
    try {
      await deletePromptTemplate(item.id);
      toast.success('已删除。');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function removePersona(item: Persona): Promise<void> {
    const confirmed = await dialog.confirm({
      title: `删除人格「${item.name}」？`,
      description: '内置人格删除后会在下次访问时重新出现。',
      tone: 'danger',
      okLabel: '删除',
    });
    if (!confirmed) return;
    try {
      await deletePersona(item.id);
      toast.success('已删除。');
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section
      className="feature-panel"
      data-testid="templates-panel"
      id={panelId}
      role="tabpanel"
    >
      <div className="feature-header">
        <div>
          <h2>模板与人格</h2>
          <p>常用的提示词骨架与角色设定。模板按需注入到 Composer；人格作用于整段对话。</p>
        </div>
        <div className="inline-toolbar" style={{ marginBottom: 0 }}>
          <button type="button" className="btn-quiet" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
          {tab === 'templates' ? (
            <button type="button" className="btn-primary" onClick={() => void addTemplate()} data-testid="template-new">
              新建模板
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={() => void addPersona()} data-testid="persona-new">
              新建人格
            </button>
          )}
        </div>
      </div>

      <div className="segmented" role="group">
        <button
          type="button"
          className={tab === 'templates' ? 'active' : ''}
          onClick={() => setTab('templates')}
          data-testid="tp-tab-templates"
        >
          提示词模板（{templates.length}）
        </button>
        <button
          type="button"
          className={tab === 'personas' ? 'active' : ''}
          onClick={() => setTab('personas')}
          data-testid="tp-tab-personas"
        >
          人格（{personas.length}）
        </button>
      </div>

      {tab === 'templates' && (
        <div className="tp-list">
          {templates.length === 0 ? (
            <p className="muted">还没有模板，点上面的「新建模板」开始。</p>
          ) : (
            templates.map((item) => {
              const isOpen = expanded === item.id;
              return (
                <article className="feature-card tp-card" key={item.id} data-testid={`template-row-${item.id}`}>
                  <div className="feature-row">
                    <strong>{item.name}</strong>
                    <div className="inline-toolbar" style={{ margin: 0 }}>
                      {onUsePromptTemplate && (
                        <button
                          type="button"
                          className="btn-quiet"
                          onClick={() => onUsePromptTemplate(item.content)}
                          data-testid={`template-use-${item.id}`}
                        >
                          注入
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() => setExpanded(isOpen ? null : item.id)}
                      >
                        {isOpen ? '收起' : '查看正文'}
                      </button>
                      <button type="button" className="btn-quiet" onClick={() => void removeTemplate(item)}>
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  </div>
                  {item.description && <p className="muted">{item.description}</p>}
                  {isOpen && <pre className="tp-content">{item.content}</pre>}
                </article>
              );
            })
          )}
        </div>
      )}

      {tab === 'personas' && (
        <div className="tp-list">
          {personas.length === 0 ? (
            <p className="muted">还没有人格。</p>
          ) : (
            personas.map((item) => {
              const isOpen = expanded === item.id;
              return (
                <article className="feature-card tp-card" key={item.id} data-testid={`persona-row-${item.id}`}>
                  <div className="feature-row">
                    <strong>{item.name}</strong>
                    <div className="inline-toolbar" style={{ margin: 0 }}>
                      <button
                        type="button"
                        className="btn-quiet"
                        onClick={() => setExpanded(isOpen ? null : item.id)}
                      >
                        {isOpen ? '收起' : '查看 prompt'}
                      </button>
                      <button type="button" className="btn-quiet" onClick={() => void removePersona(item)}>
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  </div>
                  {item.description && <p className="muted">{item.description}</p>}
                  {isOpen && <pre className="tp-content">{item.prompt}</pre>}
                </article>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
