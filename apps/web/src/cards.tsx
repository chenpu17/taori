import type { ReactNode } from 'react';
import { Icon, ModelDot, ModelLabel, MODELS, type ModelId } from './primitives';

// ── User message ─────────────────────────────────────────────
export function UserMsg({ children }: { children: ReactNode }) {
  return (
    <div className="msg">
      <div className="msg-from">我</div>
      <div className="msg-body">{children}</div>
    </div>
  );
}

// ── Assistant message (with optional fallback) ───────────────
interface AssistantMsgProps {
  model?: ModelId;
  time: string;
  cost: string;
  tokensIn?: number;
  tokensOut?: number;
  fallback?: { from: string; to: string; reason: string };
  children: ReactNode;
}

export function AssistantMsg({ model = 'sonnet', children, time, cost, fallback, tokensIn, tokensOut }: AssistantMsgProps) {
  return (
    <div className="msg">
      <div className="msg-from taori">Taori</div>
      <div className="msg-body">{children}</div>
      <div className="msg-meta">
        <ModelLabel model={model} />
        <span className="sep">·</span>
        <span>{time}</span>
        <span className="sep">·</span>
        <span>¥{cost}</span>
        {tokensIn !== undefined && (
          <>
            <span className="sep">·</span>
            <span style={{ color: 'var(--text-faint)' }}>
              {tokensIn}→{tokensOut} tok
            </span>
          </>
        )}
        <button className="reroll" type="button">
          <Icon name="refresh" size={11} />
          换个模型重答
        </button>
      </div>
      {fallback && (
        <div className="msg-fallback">
          <Icon name="warn" size={14} className="icon" />
          <span>
            <strong style={{ color: 'var(--warn)' }}>{fallback.from}</strong>
            {` ${fallback.reason}，已自动切到 `}
            <strong style={{ color: 'var(--text-primary)' }}>{fallback.to}</strong>。
          </span>
          <span className="actions">
            <button className="btn" type="button">撤销</button>
            <button className="btn" type="button">不再自动切换</button>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Roundtable card ──────────────────────────────────────────
interface RoundtableRow {
  model: ModelId;
  time: string;
  cost: string;
  tag?: '倾向 A' | '倾向 B';
  content: ReactNode;
}

export function RoundtableCard({ rows, status = 'done', totalCost }: { rows: RoundtableRow[]; status?: 'streaming' | 'done'; totalCost?: string }) {
  return (
    <div className="msg" style={{ paddingTop: 8 }}>
      <div className="modecard">
        <div className="modecard-head">
          <Icon name="roundtable" size={13} style={{ color: 'var(--accent)' }} />
          <span className="label">圆桌</span>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <span className="meta">{rows.length} 个模型</span>
          {status === 'streaming' && (
            <>
              <span style={{ color: 'var(--text-faint)' }}>·</span>
              <span className="meta" style={{ color: 'var(--accent)' }}>
                <span className="pulse" />
                进行中
              </span>
            </>
          )}
          <span className="spacer" />
          {totalCost && <span className="meta">共 ¥{totalCost}</span>}
          <button className="act" type="button">
            <Icon name="edit" size={11} />
            改成员
          </button>
          <button className="act" type="button">收起 ▴</button>
        </div>
        <div className="modecard-body" style={{ padding: '4px 14px' }}>
          {rows.map((r, i) => (
            <div className="rt-row" key={i}>
              <div className="rt-model">
                <span className="name">
                  <ModelDot model={r.model} />
                  {MODELS[r.model].short}
                </span>
                <span className="stats">
                  {r.time} · ¥{r.cost}
                </span>
                {r.tag && <span className={'tag ' + (r.tag === '倾向 A' ? 'a' : 'b')}>{r.tag}</span>}
              </div>
              <div className="rt-content">{r.content}</div>
            </div>
          ))}
        </div>
        {status === 'done' && (
          <div className="rt-footer">
            <button className="rt-btn primary" type="button">
              <Icon name="spark" size={12} />
              让 Taori 综合
            </button>
            <button className="rt-btn" type="button">选 Sonnet 继续</button>
            <button className="rt-btn" type="button">选 GPT-4o 继续</button>
            <span style={{ flex: 1 }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Research (in progress) ───────────────────────────────────
export function ResearchInProgress({
  progress = 50,
  iter = '2/4',
  sources = 12,
  papers = 5,
  now,
  cost,
}: {
  progress?: number;
  iter?: string;
  sources?: number;
  papers?: number;
  now: ReactNode;
  cost: string;
}) {
  return (
    <div className="msg" style={{ paddingTop: 8 }}>
      <div className="modecard">
        <div className="modecard-head">
          <Icon name="research" size={13} style={{ color: 'var(--accent)' }} />
          <span className="label">研究</span>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <span className="meta" style={{ color: 'var(--accent)' }}>
            <span className="pulse" />
            进行中
          </span>
          <span className="spacer" />
          <span className="meta">已用 ¥{cost}</span>
          <button className="act" type="button">详情</button>
          <button className="act" type="button">
            <Icon name="pause" size={10} />
            暂停
          </button>
        </div>
        <div className="modecard-body">
          <div className="research-progress">
            <div className="research-progress-fill" style={{ width: progress + '%' }} />
          </div>
          <div className="research-meta">
            <span><span className="k">迭代</span> {iter}</span>
            <span><span className="k">搜索</span> {sources} 条</span>
            <span><span className="k">阅读</span> {papers} 篇</span>
          </div>
          <div className="research-now">
            <span className="pulse" />
            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>当前在做：</span>
            {now}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Research (done) ──────────────────────────────────────────
export function ResearchDone({ title, summary, citations = 12, cost }: { title: string; summary: ReactNode; citations?: number; cost: string }) {
  return (
    <div className="msg" style={{ paddingTop: 8 }}>
      <div className="modecard">
        <div className="modecard-head">
          <Icon name="research" size={13} style={{ color: 'var(--ok)' }} />
          <span className="label">研究</span>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <span className="meta" style={{ color: 'var(--ok)' }}>
            <Icon name="check" size={11} style={{ marginRight: 3 }} />
            完成
          </span>
          <span className="spacer" />
          <span className="meta">共 ¥{cost}</span>
        </div>
        <div className="modecard-body">
          <div style={{ fontSize: 15, color: 'var(--text-primary)', marginBottom: 8, fontWeight: 500, letterSpacing: '-0.01em' }}>{title}</div>
          <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: 14 }}>{summary}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="rt-btn primary" type="button">展开报告</button>
            <button className="rt-btn" type="button">
              <Icon name="globe" size={11} />
              查看引用 {citations}
            </button>
            <button className="rt-btn" type="button">
              <Icon name="download" size={11} />
              导出 Markdown
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Compare card ─────────────────────────────────────────────
interface CompareCol {
  model: ModelId;
  content: ReactNode;
  time: string;
  cost: string;
}

export function CompareCard({ cols, picked }: { cols: CompareCol[]; picked?: ModelId }) {
  return (
    <div className="msg" style={{ paddingTop: 8 }}>
      <div className="modecard">
        <div className="modecard-head">
          <Icon name="compare" size={13} style={{ color: 'var(--accent)' }} />
          <span className="label">对比</span>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <span className="meta">{cols.length} 个模型并排</span>
          <span className="spacer" />
          <button className="act" type="button">改组合</button>
        </div>
        <div className="modecard-body">
          <div className="compare-grid">
            {cols.map((c, i) => (
              <div className="compare-col" key={i}>
                <div className="compare-col-head">
                  <ModelDot model={c.model} />
                  {MODELS[c.model].short}
                </div>
                <div className="compare-content">{c.content}</div>
                <div className="compare-stats">{c.time} · ¥{c.cost}</div>
                <button className={'compare-pick' + (picked === c.model ? ' picked' : '')} type="button">
                  {picked === c.model ? '✓ 已选这个' : '选这个 ↺'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Image card ───────────────────────────────────────────────
function PosterSVG({ tone = 'a', seed = 0 }: { tone?: 'a' | 'b' | 'c' | 'd'; seed?: number }) {
  const grads: Record<string, [string, string, string]> = {
    a: ['#1B1233', '#4A1B5E', '#C44C8C'],
    b: ['#082842', '#0B5475', '#42A5C9'],
    c: ['#2A1010', '#7A2528', '#DA6855'],
    d: ['#0E2A23', '#1A6B58', '#6FCDB1'],
  };
  const palette = grads[tone];
  const id = 'p' + seed;
  return (
    <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={palette[0]} />
          <stop offset="0.55" stopColor={palette[1]} />
          <stop offset="1" stopColor={palette[2]} />
        </linearGradient>
      </defs>
      <rect width="200" height="200" fill={`url(#${id})`} />
      <g fill="#000" opacity="0.55">
        <rect x="0" y="130" width="22" height="70" />
        <rect x="24" y="115" width="18" height="85" />
        <rect x="42" y="138" width="14" height="62" />
        <rect x="56" y="105" width="30" height="95" />
        <rect x="88" y="125" width="22" height="75" />
        <rect x="110" y="95" width="14" height="105" />
        <rect x="126" y="118" width="28" height="82" />
        <rect x="154" y="105" width="20" height="95" />
        <rect x="176" y="130" width="24" height="70" />
      </g>
      {Array.from({ length: 24 }).map((_, i) => (
        <rect key={i} x={5 + ((i * 7.5) % 190)} y={135 + ((i * 13) % 50)} width="1.5" height="2" fill={palette[2]} opacity={0.85} />
      ))}
      <circle cx="155" cy="45" r="16" fill={palette[2]} opacity="0.18" />
      <circle cx="155" cy="45" r="10" fill={palette[2]} opacity="0.32" />
      <text x="100" y="80" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="14" fontWeight="700" fill={palette[2]} letterSpacing="2">CAFÉ</text>
      <text x="100" y="93" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="6" fill="#FFF" opacity="0.6" letterSpacing="3">OPEN · 24H</text>
      <g stroke="#FFF" strokeWidth="0.2" opacity="0.15">
        <line x1="0" y1="60" x2="200" y2="60" />
        <line x1="0" y1="100" x2="200" y2="100" />
      </g>
    </svg>
  );
}

export function ImageCard({ model = 'dalle', cost }: { model?: ModelId; cost: string }) {
  return (
    <div className="msg" style={{ paddingTop: 8 }}>
      <div className="modecard">
        <div className="modecard-head">
          <Icon name="image" size={13} style={{ color: 'var(--accent)' }} />
          <span className="label">生图</span>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <span className="meta">
            <ModelDot model={model} size={6} /> {MODELS[model].short}
          </span>
          <span className="spacer" />
          <span className="meta">¥{cost}</span>
        </div>
        <div className="modecard-body">
          <div className="image-grid">
            <div className="image-cell"><PosterSVG tone="a" seed={1} /></div>
            <div className="image-cell"><PosterSVG tone="b" seed={2} /></div>
            <div className="image-cell"><PosterSVG tone="c" seed={3} /></div>
            <div className="image-cell"><PosterSVG tone="d" seed={4} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="rt-btn primary" type="button">
              <Icon name="download" size={11} />
              下载
            </button>
            <button className="rt-btn" type="button">再画 4 张</button>
            <button className="rt-btn" type="button">换模型</button>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center' }}>1024×1024 · seed 80142</span>
          </div>
        </div>
      </div>
    </div>
  );
}
