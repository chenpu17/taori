import os from 'node:os';
import type { SidecarConfig } from './config.js';

export interface RuntimeResourceSnapshot {
  pid: number;
  started_at: number;
  uptime_ms: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
  cpu_percent: number | null;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  system_memory_bytes: number;
  system_free_memory_bytes: number;
  available_parallelism: number;
  db_path: string;
  control_mode: 'desktop' | 'standalone';
}

export function createRuntimeMonitor(args: {
  startedAt: number;
  config: SidecarConfig;
}): () => RuntimeResourceSnapshot {
  let lastCpu = process.cpuUsage();
  let lastWall = process.hrtime.bigint();
  let seenFirstSample = false;

  return () => {
    const memory = process.memoryUsage();
    const currentCpu = process.cpuUsage();
    const currentWall = process.hrtime.bigint();

    const deltaCpuMicros =
      currentCpu.user - lastCpu.user + (currentCpu.system - lastCpu.system);
    const deltaWallMicros = Number(currentWall - lastWall) / 1_000;

    lastCpu = currentCpu;
    lastWall = currentWall;

    const cpuPercent = seenFirstSample && deltaWallMicros > 0
      ? Math.round((deltaCpuMicros / deltaWallMicros) * 1000) / 10
      : null;
    seenFirstSample = true;

    return {
      pid: process.pid,
      started_at: args.startedAt,
      uptime_ms: Date.now() - args.startedAt,
      cpu_user_ms: Math.round(currentCpu.user / 1000),
      cpu_system_ms: Math.round(currentCpu.system / 1000),
      cpu_percent: cpuPercent,
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
      system_memory_bytes: os.totalmem(),
      system_free_memory_bytes: os.freemem(),
      available_parallelism: os.availableParallelism(),
      db_path: args.config.dbPath,
      control_mode: args.config.controlUrl ? 'desktop' : 'standalone',
    };
  };
}
