import type { FastifyReply } from 'fastify';
import type { Repos } from '../../db/repos/index.js';
import { makeId } from '@taori/shared';
import { writeAnnotationPart, writeFinishPart } from '../../chat/protocol.js';
import { openDataStream } from '../../chat/stream-dispatch.js';

export interface CapabilityRouteInput {
  conversationId: string;
  capability: string;
  prompt: string;
  userMessageId: string;
  lastUserContent: string | null;
  origin: string | undefined;
}

const CAPABILITY_LABELS: Record<string, { route: string; summary: string }> = {
  image: { route: '路由到图像生成', summary: '已等待用户选择图像生成模型' },
};

function capabilityLabel(cap: string, kind: 'route' | 'summary'): string {
  return CAPABILITY_LABELS[cap]?.[kind] ?? `路由到 ${cap}`;
}

export async function handleCapabilityRoute(
  repos: Repos,
  input: CapabilityRouteInput,
  reply: FastifyReply,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<void> {
  const dataStream = openDataStream(input.origin, reply);
  const { stream } = dataStream;
  const runId = makeId('run');

  repos.runEvents.appendSafe({
    run_id: runId,
    conversation_id: input.conversationId,
    message_id: null,
    kind: 'turn.started',
    status: 'started',
    label: '用户回合开始',
    summary: input.lastUserContent?.slice(0, 120) ?? null,
    payload: { route: 'capability', capability: input.capability },
  }, log);

  repos.runEvents.appendSafe({
    run_id: runId,
    conversation_id: input.conversationId,
    message_id: null,
    kind: 'capability.routed',
    status: 'completed',
    label: capabilityLabel(input.capability, 'route'),
    summary: input.prompt.slice(0, 180),
    payload: {
      capability: input.capability,
      user_message_id: input.userMessageId,
    },
  }, log);

  writeAnnotationPart(stream, [{
    type: 'meta',
    conversation_id: input.conversationId,
    message_id: null,
    model_id: null,
    run_id: runId,
  }]);
  writeAnnotationPart(stream, [{
    type: 'capability_route',
    capability: input.capability,
    prompt: input.prompt,
    user_message_id: input.userMessageId,
    conversation_id: input.conversationId,
  }]);
  writeFinishPart(stream, {
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0 },
  });

  repos.runEvents.appendSafe({
    run_id: runId,
    conversation_id: input.conversationId,
    message_id: null,
    kind: 'turn.completed',
    status: 'completed',
    label: '用户回合完成',
    summary: capabilityLabel(input.capability, 'summary'),
  }, log);

  stream.end();
}
