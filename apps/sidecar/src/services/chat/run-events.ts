/**
 * Shared helpers for appending run-event payloads used by continue-run
 * and recover-run service functions.
 */

import type { RunEventsRepo } from '../../db/repos/index.js';

type LogLike = { warn: (...a: unknown[]) => void; info?: (...a: unknown[]) => void };

/**
 * Build the common recovery-addon fields shared across recovery.started,
 * turn.started, and recovery.completed / recovery.failed payloads.
 */
export function buildRecoveryPayloadAddons(input: {
  action: string;
  parentRunId: string;
  assistantMessageId: string;
  originalAssistantMessageId?: string;
  modelId?: string;
  sourceUserMessageId?: string | null;
  recoveryPolicy?: string;
  skipToolName?: string | null;
  failedToolLabel?: string | null;
  compacted?: { compacted_message_count: number; summary_chars: number } | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action: input.action,
    parent_run_id: input.parentRunId,
    assistant_message_id: input.assistantMessageId,
  };
  if (input.originalAssistantMessageId) {
    payload.original_assistant_message_id = input.originalAssistantMessageId;
  }
  if (input.modelId) {
    payload.model_id = input.modelId;
  }
  if (input.sourceUserMessageId != null) {
    payload.source_user_message_id = input.sourceUserMessageId;
  }
  if (input.recoveryPolicy) {
    payload.recovery_policy = input.recoveryPolicy;
  }
  if (input.skipToolName) {
    payload.skipped_tool_name = input.skipToolName;
    payload.skipped_tool_label = input.failedToolLabel ?? input.skipToolName;
  }
  if (input.compacted) {
    payload.compacted_message_count = input.compacted.compacted_message_count;
    payload.compacted_summary_chars = input.compacted.summary_chars;
  }
  return payload;
}

export interface TurnStartedEventInput {
  run_id: string;
  conversation_id: string;
  message_id: string;
  run_kind: 'continue' | 'retry';
  parent_run_id: string;
  model_id: string;
  source_user_message_id: string | null;
  assistant_message_id: string;
  label: string;
  summary: string | null;
  extra_payload?: Record<string, unknown>;
}

export function appendTurnStartedEvent(
  log: LogLike,
  runEventsRepo: Pick<RunEventsRepo, 'appendSafe'>,
  input: TurnStartedEventInput,
): void {
  const payload: Record<string, unknown> = {
    run_kind: input.run_kind,
    parent_run_id: input.parent_run_id,
    model_id: input.model_id,
    source_user_message_id: input.source_user_message_id,
    assistant_message_id: input.assistant_message_id,
  };
  if (input.extra_payload) {
    Object.assign(payload, input.extra_payload);
  }
  runEventsRepo.appendSafe(
    {
      run_id: input.run_id,
      conversation_id: input.conversation_id,
      message_id: input.message_id,
      kind: 'turn.started',
      status: 'started',
      label: input.label,
      summary: input.summary,
      payload,
    },
    log,
  );
}
