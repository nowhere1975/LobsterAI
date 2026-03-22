import { EventEmitter } from 'events';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
  CoworkContinueOptions,
  CoworkRuntime,
  CoworkRuntimeEvents,
  CoworkStartOptions,
} from './types';

type RouterDeps = {
  claudeRuntime: CoworkRuntime;
};

export class CoworkEngineRouter extends EventEmitter implements CoworkRuntime {
  private readonly claudeRuntime: CoworkRuntime;

  constructor(deps: RouterDeps) {
    super();
    this.claudeRuntime = deps.claudeRuntime;
    this.bindRuntimeEvents(this.claudeRuntime);
  }

  override on<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override off<U extends keyof CoworkRuntimeEvents>(
    event: U,
    listener: CoworkRuntimeEvents[U],
  ): this {
    return super.off(event, listener);
  }

  async startSession(sessionId: string, prompt: string, options: CoworkStartOptions = {}): Promise<void> {
    return this.claudeRuntime.startSession(sessionId, prompt, options);
  }

  async continueSession(sessionId: string, prompt: string, options: CoworkContinueOptions = {}): Promise<void> {
    return this.claudeRuntime.continueSession(sessionId, prompt, options);
  }

  stopSession(sessionId: string): void {
    this.claudeRuntime.stopSession(sessionId);
  }

  stopAllSessions(): void {
    this.claudeRuntime.stopAllSessions();
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    this.claudeRuntime.respondToPermission(requestId, result);
  }

  isSessionActive(sessionId: string): boolean {
    return this.claudeRuntime.isSessionActive(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.claudeRuntime.getSessionConfirmationMode(sessionId);
  }

  onSessionDeleted(sessionId: string): void {
    this.claudeRuntime.onSessionDeleted?.(sessionId);
  }

  private bindRuntimeEvents(runtime: CoworkRuntime): void {
    runtime.on('message', (sessionId, message) => {
      this.emit('message', sessionId, message);
    });

    runtime.on('messageUpdate', (sessionId, messageId, content) => {
      this.emit('messageUpdate', sessionId, messageId, content);
    });

    runtime.on('permissionRequest', (sessionId, request) => {
      this.emit('permissionRequest', sessionId, request);
    });

    runtime.on('complete', (sessionId, claudeSessionId) => {
      this.emit('complete', sessionId, claudeSessionId);
    });

    runtime.on('error', (sessionId, error) => {
      this.emit('error', sessionId, error);
    });
  }
}
