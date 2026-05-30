import type { FastifyReply } from 'fastify';
import { PassThrough } from 'node:stream';
import type { Model, Provider } from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import type {
  ConversationsRepo,
  CostsRepo,
  MemoriesRepo,
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  StructuredMemoriesRepo,
} from '../db/repos/index.js';
import { finalizeOnEnd, type ProduceCtx } from './run-stream.js';
import type { StreamObserver } from './protocol.js';
import {
  produceKeyMissingStream,
  produceMockStream,
  produceUpstreamStream,
} from './stream-producers.js';
import { produceDeepSeekUpstreamStream } from './deepseek-tools-loop.js';
import { shouldUseDeepSeekToolLoop } from './deepseek-tool-loop-policy.js';

export function prepareDataStreamReply(origin: unknown, reply: FastifyReply): void {
  if (
    typeof origin === 'string' &&
    (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
      origin === 'tauri://localhost' ||
      origin.startsWith('http://tauri.localhost'))
  ) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Expose-Headers', 'x-vercel-ai-data-stream');
  }
  reply
    .type('text/plain; charset=utf-8')
    .header('Cache-Control', 'no-cache, no-transform')
    .header('Connection', 'keep-alive')
    .header('x-vercel-ai-data-stream', 'v1');
  if (typeof reply.raw.socket?.setNoDelay === 'function') {
    reply.raw.socket.setNoDelay(true);
  }
}

export function openDataStream(
  origin: unknown,
  reply: FastifyReply,
): {
  stream: PassThrough;
  abortController: AbortController;
  isAborted: () => boolean;
  setForceFinalize: (fn: (() => void) | null) => void;
} {
  const stream = new PassThrough();
  prepareDataStreamReply(origin, reply);
  const abortController = new AbortController();
  let aborted = false;
  let forceFinalize: (() => void) | null = null;
  reply.raw.on('close', () => {
    if (!stream.writableEnded) {
      aborted = true;
      abortController.abort();
      if (!stream.writableEnded) stream.end();
      forceFinalize?.();
    }
  });
  reply.send(stream);
  return {
    stream,
    abortController,
    isAborted: () => aborted,
    setForceFinalize: (fn) => { forceFinalize = fn; },
  };
}

export async function dispatchChatProducer(args: {
  stream: PassThrough;
  abortSignal: AbortSignal;
  isAborted: () => boolean;
  ctx: ProduceCtx;
  model: Model | null;
  provider: Provider | null;
  modelName: string;
  keystore: BuildServerArgs['keystore'];
  msgRepo: MessagesRepo;
  costsRepo: CostsRepo;
  modelsRepo: ModelsRepo;
  providersRepo?: ProvidersRepo;
  memoriesRepo: MemoriesRepo;
  structuredMemoriesRepo?: StructuredMemoriesRepo;
  /** When set, the first-turn title is upgraded to an AI title (chat.ts only). */
  convRepo?: ConversationsRepo;
  /** Hermetic e2e: skip the live title-generation call. */
  hermetic?: boolean;
  setForceFinalize: (fn: (() => void) | null) => void;
  onFinish?: () => void;
  keyReadFailedLogName: string;
  unhandledLogName: string;
}): Promise<void> {
  const { finalize, observer } = finalizeOnEnd(
    args.stream,
    args.isAborted,
    args.ctx,
    args.msgRepo,
    args.costsRepo,
    args.modelsRepo,
    args.providersRepo,
    args.memoriesRepo,
    args.structuredMemoriesRepo,
    args.keystore,
    args.convRepo,
    args.hermetic,
  );
  args.setForceFinalize(finalize);
  if (args.onFinish) args.stream.on('finish', args.onFinish);

  if (args.provider?.type === 'ollama') {
      void produceUpstreamStream(
        args.stream,
        args.abortSignal,
        args.ctx,
        {
          apiKey: 'ollama-local',
        },
        args.provider,
        args.model!,
        args.modelsRepo,
        args.memoriesRepo,
        observer,
      ).catch((e) => args.ctx.log.error({ err: e }, args.unhandledLogName));
    return;
  }

  if (args.provider?.api_key_ref) {
    let apiKey: string | null = null;
    try {
      apiKey = await args.keystore.read(args.provider.api_key_ref);
    } catch (e) {
      args.ctx.log.warn({ err: e }, args.keyReadFailedLogName);
    }
    if (apiKey) {
      const producer =
        shouldUseDeepSeekToolLoop(args.provider, args.modelName, args.ctx.supportsTools)
          ? produceDeepSeekUpstreamStream
          : produceUpstreamStream;
      void producer(
        args.stream,
        args.abortSignal,
        args.ctx,
        {
          apiKey,
        },
        args.provider,
        args.model!,
        args.modelsRepo,
        args.memoriesRepo,
        observer,
      ).catch((e) => args.ctx.log.error({ err: e }, args.unhandledLogName));
      return;
    }
    void produceKeyMissingStream(args.stream, args.ctx, args.modelsRepo, args.memoriesRepo, observer);
    return;
  }

  void produceMockStream(
    args.stream,
    args.isAborted,
    args.ctx,
    args.modelsRepo,
    args.memoriesRepo,
    observer,
  );
}
