/**
 * M3.A.3 — Roundtable export to Markdown (spec §3.4).
 *
 * Pure function: given the roundtable + its messages + cost records, render
 * the canonical Markdown template. No I/O — the route does the DB lookups
 * and feeds them in.
 *
 * Sections:
 *   1. Title + metadata (mode, created_at, total cost)
 *   2. Participants (numbered)
 *   3. 第一轮发言 (round 1, sorted by participant_index)
 *   4. 第二轮发言（互见反驳） — only when round 2 exists
 *   5. 总结 — structured (consensus / divergence / risks / recommended_decision /
 *      next_steps), or fallback section if `summary.fallback === true`.
 *   6. 成本明细 — table grouped by stage (analyzer / round1.p1 ... / summarizer).
 */

import type {
  CostRecord,
  RoundtableMessageRow,
  RoundtableRow,
} from '../db/repos/index.js';
import type { SummaryStorage, RoundtableSummary } from '@taori/shared';

function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '$0.0000';
  return `$${n.toFixed(4)}`;
}

function fmtDate(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function modeLabel(mode: RoundtableRow['mode']): string {
  return mode === 'fast' ? '快速' : '深度';
}

function isStructuredSummary(
  s: SummaryStorage | null,
): s is RoundtableSummary {
  return !!s && !('fallback' in s && s.fallback === true);
}

/**
 * A4 — render the structured summary as markdown for embedding into a chat
 * conversation. Same body the export function uses, minus the leading H2
 * heading so callers can wrap in their own header.
 */
export function renderRoundtableSummaryMarkdown(
  summary: SummaryStorage | null,
): string {
  return renderSummary(summary).join('\n').trim();
}

function renderSummary(summary: SummaryStorage | null): string[] {
  const out: string[] = [];
  if (!summary) {
    out.push('## 总结', '');
    out.push('（暂无总结）', '');
    return out;
  }
  if (!isStructuredSummary(summary)) {
    out.push('## 总结（自动总结失败）', '');
    out.push(summary.raw_text || '（无）', '');
    return out;
  }
  out.push('## 总结', '');
  out.push('### ✅ 共识', '');
  if (summary.consensus.length === 0) {
    out.push('（无）');
  } else {
    for (const c of summary.consensus) out.push(`- ${c}`);
  }
  out.push('');

  out.push('### ⚠️ 分歧', '');
  if (summary.divergence.length === 0) {
    out.push('（无）');
  } else {
    for (const d of summary.divergence) {
      out.push(`- **${d.topic}**`);
      for (const p of d.positions) {
        out.push(`  - ${p.role}: ${p.stance}`);
      }
    }
  }
  out.push('');

  out.push('### 🚨 风险', '');
  if (summary.risks.length === 0) {
    out.push('（无）');
  } else {
    for (const r of summary.risks) out.push(`- ${r}`);
  }
  out.push('');

  out.push('### 🎯 推荐决策', '');
  out.push(summary.recommended_decision || '（无）');
  out.push('');

  out.push('### 📋 下一步', '');
  if (summary.next_steps.length === 0) {
    out.push('（无）');
  } else {
    summary.next_steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  }
  out.push('');
  return out;
}

interface CostRow {
  stage: string;
  modelName: string;
  calls: number;
  totalUsd: number;
}

function aggregateCosts(
  rt: RoundtableRow,
  messages: RoundtableMessageRow[],
  costs: CostRecord[],
): { rows: CostRow[]; totalUsd: number; totalCalls: number } {
  const rows: CostRow[] = [];
  let totalUsd = 0;
  let totalCalls = 0;

  const analyzerRows = costs.filter((c) => c.source_type === 'topic_analyzer');
  if (analyzerRows.length > 0) {
    const sum = analyzerRows.reduce((s, r) => s + (r.actual_cost_usd ?? 0), 0);
    rows.push({
      stage: '话题分析',
      modelName:
        analyzerRows[0]!.model_name_snapshot ??
        analyzerRows[0]!.model_id ??
        '—',
      calls: analyzerRows.length,
      totalUsd: sum,
    });
    totalUsd += sum;
    totalCalls += analyzerRows.length;
  }

  for (const round of [1, 2] as const) {
    const roundMessages = messages
      .filter((m) => m.round === round)
      .sort((a, b) => a.participant_index - b.participant_index);
    if (roundMessages.length === 0) continue;
    for (const m of roundMessages) {
      const role =
        rt.participants[m.participant_index]?.role_label ??
        `参与者${m.participant_index + 1}`;
      const msgCosts = costs.filter(
        (c) => c.source_type === 'roundtable_message' && c.source_id === m.id,
      );
      if (msgCosts.length === 0) continue;
      const sum = msgCosts.reduce((s, r) => s + (r.actual_cost_usd ?? 0), 0);
      rows.push({
        stage: `第 ${round} 轮 · ${role}`,
        modelName: msgCosts[0]!.model_name_snapshot ?? msgCosts[0]!.model_id ?? '—',
        calls: msgCosts.length,
        totalUsd: sum,
      });
      totalUsd += sum;
      totalCalls += msgCosts.length;
    }
  }

  const summarizerRows = costs.filter((c) => c.source_type === 'summarizer');
  if (summarizerRows.length > 0) {
    const sum = summarizerRows.reduce(
      (s, r) => s + (r.actual_cost_usd ?? 0),
      0,
    );
    rows.push({
      stage: '总结',
      modelName:
        summarizerRows[0]!.model_name_snapshot ??
        summarizerRows[0]!.model_id ??
        '—',
      calls: summarizerRows.length,
      totalUsd: sum,
    });
    totalUsd += sum;
    totalCalls += summarizerRows.length;
  }

  return { rows, totalUsd, totalCalls };
}

export function renderRoundtableMarkdown(args: {
  roundtable: RoundtableRow;
  messages: RoundtableMessageRow[];
  costs: CostRecord[];
}): string {
  const { roundtable: rt, messages, costs } = args;
  const out: string[] = [];

  const { rows: costRows, totalUsd, totalCalls } = aggregateCosts(rt, messages, costs);

  out.push(`# 圆桌讨论：${rt.topic}`, '');
  out.push(
    `**模式：** ${modeLabel(rt.mode)} | **创建时间：** ${fmtDate(rt.created_at)} | **总成本：** ${fmtUsd(totalUsd)}`,
    '',
  );

  out.push('## 参与者', '');
  rt.participants.forEach((p, i) => {
    out.push(
      `${i + 1}. **${p.role_label}** - ${p.display_name} (\`${p.model_id}\`)`,
    );
  });
  out.push('');
  out.push('---', '');

  for (const round of [1, 2] as const) {
    const roundMessages = messages
      .filter((m) => m.round === round)
      .sort((a, b) => a.participant_index - b.participant_index);
    if (roundMessages.length === 0) continue;
    out.push(round === 1 ? '## 第一轮发言' : '## 第二轮发言（互见反驳）', '');
    for (const m of roundMessages) {
      const role =
        rt.participants[m.participant_index]?.role_label ??
        `参与者${m.participant_index + 1}`;
      const display =
        rt.participants[m.participant_index]?.display_name ?? m.model_id ?? '';
      out.push(`### ${role} (${display})`, '');
      if (m.status === 'complete' && m.content.trim()) {
        out.push(m.content.trim(), '');
      } else {
        out.push(`（该参与者本轮未完成：${m.classification ?? m.status}）`, '');
      }
    }
    out.push('---', '');
  }

  out.push(...renderSummary(rt.summary));
  out.push('---', '');

  out.push('## 成本明细', '');
  out.push('| 阶段 | 模型 | 调用 | 成本 |');
  out.push('|---|---|---|---|');
  for (const r of costRows) {
    out.push(
      `| ${r.stage} | ${r.modelName} | ${r.calls} | ${fmtUsd(r.totalUsd)} |`,
    );
  }
  out.push(`| **总计** | | **${totalCalls}** | **${fmtUsd(totalUsd)}** |`);
  out.push('');

  return out.join('\n');
}
