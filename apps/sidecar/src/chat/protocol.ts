export interface DataStreamWriter {
  write(chunk: string): boolean;
}

/**
 * Callback observer that producers notify directly when writing frames.
 * Used by persistence (finalizeOnEnd) to capture text, cost, and error
 * information without having to sniff the stream's own `data` events.
 */
export interface StreamObserver {
  onText?(text: string): void;
  onAnnotation?(annotations: Record<string, unknown>[]): void;
  onError?(message: string): void;
}

function writePart(stream: DataStreamWriter, code: string, payload: unknown): boolean {
  return stream.write(`${code}:${JSON.stringify(payload)}\n`);
}

export function writeTextPart(stream: DataStreamWriter, text: string, observer?: StreamObserver): boolean {
  observer?.onText?.(text);
  return writePart(stream, '0', text);
}

export function writeAnnotationPart(stream: DataStreamWriter, annotations: unknown[], observer?: StreamObserver): boolean {
  const records = annotations as Record<string, unknown>[];
  observer?.onAnnotation?.(records);
  return writePart(stream, '8', annotations);
}

export function writeErrorPart(stream: DataStreamWriter, message: string, observer?: StreamObserver): boolean {
  observer?.onError?.(message);
  return writePart(stream, '3', message);
}

export function writeStepFinishPart(stream: DataStreamWriter, payload: unknown): boolean {
  return writePart(stream, 'e', payload);
}

export function writeFinishPart(stream: DataStreamWriter, payload: unknown): boolean {
  return writePart(stream, 'd', payload);
}
