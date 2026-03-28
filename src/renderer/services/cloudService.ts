/**
 * UdiskAI 内置额度云服务
 *
 * 负责：设备 ID 管理、余额查询、AI 请求代理、充值流程
 * 设备 ID 存储在 data/udiskai.sqlite（跟随 U 盘，不绑定机器）
 */

import { configService } from './config';
import { ChatMessagePayload, ChatUserMessageInput } from '../types/chat';

const CREDITS_SYNC_INTERVAL = 5 * 60 * 1000; // 5 分钟同步一次
const CHAT_SERVER_URL = 'http://1.14.96.63:3000'; // LLM relay，写死，不读配置
const USER_SERVER_URL = 'https://udiskai.top/api'; // 用户管理（注册/积分/充值），写死，nginx /api/ → port 8888

class CloudService {
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private unsubWindowState: (() => void) | null = null;
  private lastFocusRefreshTime = 0;
  private creditsExhaustedListeners: Array<() => void> = [];

  /** 注册积分耗尽回调，用于 UI 层弹出充值提示 */
  onCreditsExhausted(listener: () => void): () => void {
    this.creditsExhaustedListeners.push(listener);
    return () => {
      this.creditsExhaustedListeners = this.creditsExhaustedListeners.filter(l => l !== listener);
    };
  }

  private notifyCreditsExhausted() {
    for (const listener of this.creditsExhaustedListeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────

  async init() {
    const cfg = this.getCloudConfig();
    if (!cfg.enabled) return;

    await this.ensureRegistered();
    this.startSyncTimer();
    this.startFocusRefresh();
  }

  // ── Device ID ────────────────────────────────────────────────────────────

  /** 获取或创建设备 ID（首次调用时自动生成并持久化） */
  async getOrCreateDeviceId(): Promise<string> {
    const cfg = this.getCloudConfig();
    if (cfg.deviceId) return cfg.deviceId;

    const id = crypto.randomUUID();
    await configService.updateConfig({ cloud: { ...cfg, deviceId: id } });
    return id;
  }

  // ── 注册 & 余额 ──────────────────────────────────────────────────────────

  /** 首次注册设备，获取免费额度 */
  async ensureRegistered(): Promise<number> {
    const cfg = this.getCloudConfig();
    const deviceId = await this.getOrCreateDeviceId();

    try {
      const res = await fetch(`${cfg.userServerUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      });
      if (!res.ok) throw new Error(`register failed: ${res.status}`);
      const data = await res.json();
      await this.updateCachedCredits(data.credits);
      if (data.modelId && data.modelName) {
        await this.updateCachedModel(data.modelId, data.modelName);
      }
      return data.credits;
    } catch (err) {
      console.warn('[cloud] register/sync failed:', err);
      return cfg.credits;
    }
  }

  /** 从服务端同步最新余额 */
  async syncCredits(): Promise<number> {
    const cfg = this.getCloudConfig();
    const deviceId = await this.getOrCreateDeviceId();

    try {
      const res = await fetch(`${cfg.userServerUrl}/credits?deviceId=${encodeURIComponent(deviceId)}`);
      if (res.status === 404) {
        // 设备不存在，重新注册
        return await this.ensureRegistered();
      }
      if (!res.ok) throw new Error(`credits query failed: ${res.status}`);
      const data = await res.json();
      await this.updateCachedCredits(data.credits);
      if (data.modelId && data.modelName) {
        await this.updateCachedModel(data.modelId, data.modelName);
      }
      return data.credits;
    } catch (err) {
      console.warn('[cloud] credits sync failed:', err);
      return cfg.credits;
    }
  }

  getCachedCredits(): number {
    return this.getCloudConfig().credits;
  }

  getCachedModel(): { modelId: string; modelName: string } {
    const cfg = this.getCloudConfig();
    return {
      modelId: cfg.modelId || 'deepseek-chat',
      modelName: cfg.modelName || 'DeepSeek-V3',
    };
  }

  // ── Chat 代理 ─────────────────────────────────────────────────────────────

  /** 通过服务端代理发送 AI 请求（流式） */
  async chat(
    message: ChatUserMessageInput,
    onProgress: (content: string) => void,
    history: ChatMessagePayload[],
    modelId: string,
    systemPrompt?: string
  ): Promise<{ content: string }> {
    const cfg = this.getCloudConfig();
    const deviceId = await this.getOrCreateDeviceId();

    if (cfg.credits <= 0) {
      // 先同步确认，防止缓存误差
      const latest = await this.syncCredits();
      if (latest <= 0) {
        throw new CloudCreditsError('积分不足，充值后继续使用');
      }
    }

    // 组装 messages
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const h of history) {
      if (h.content?.trim()) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: 'user', content: message.content || '' });

    const body = JSON.stringify({
      deviceId,
      messages,
      model: modelId || 'deepseek-chat',
      stream: true,
    });

    const res = await fetch(`${cfg.chatServerUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 402) {
      await this.updateCachedCredits(0);
      throw new CloudCreditsError('积分不足，充值后继续使用');
    }
    if (!res.ok) {
      throw new Error(`cloud chat failed: ${res.status}`);
    }

    // 读取 SSE 流
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          // 余额更新
          if (parsed.credits_remaining !== undefined) {
            await this.updateCachedCredits(parsed.credits_remaining);
            if (parsed.credits_remaining <= 0) {
              this.notifyCreditsExhausted();
            }
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onProgress(fullContent);
          }
        } catch { /* ignore malformed chunk */ }
      }
    }

    // 从响应头更新余额（非流式时有效，流式时通过 X-Credits-Remaining 不一定能拿到）
    const remaining = res.headers.get('X-Credits-Remaining');
    if (remaining) {
      await this.updateCachedCredits(parseInt(remaining, 10));
    }

    return { content: fullContent };
  }

  // ── 充值 ──────────────────────────────────────────────────────────────────

  async createPayOrder(packageId: string, customAmount?: number): Promise<{ orderId: string; payUrl: string; amount: number; credits: number }> {
    const cfg = this.getCloudConfig();
    const deviceId = await this.getOrCreateDeviceId();

    const res = await fetch(`${cfg.userServerUrl}/pay/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, packageId, customAmount }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `pay/create failed: ${res.status}`);
    }
    return res.json();
  }

  async pollPayStatus(orderId: string): Promise<'pending' | 'paid'> {
    const cfg = this.getCloudConfig();
    const res = await fetch(`${cfg.userServerUrl}/pay/status?orderId=${encodeURIComponent(orderId)}`);
    if (!res.ok) throw new Error(`pay/status failed: ${res.status}`);
    const data = await res.json();
    if (data.status === 'paid' && data.credits !== undefined) {
      // Refresh credits from server after payment
      await this.syncCredits();
    }
    return data.status;
  }

  // ── Mode switch ───────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.getCloudConfig().enabled === true;
  }

  async enable() {
    const cfg = this.getCloudConfig();
    await configService.updateConfig({ cloud: { ...cfg, enabled: true } });
    await this.ensureRegistered();
    this.startSyncTimer();
    this.startFocusRefresh();
  }

  async disable() {
    const cfg = this.getCloudConfig();
    await configService.updateConfig({ cloud: { ...cfg, enabled: false } });
    this.stopSyncTimer();
    this.stopFocusRefresh();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private getCloudConfig() {
    const config = configService.getConfig();
    const cloud = config.cloud ?? { enabled: false, deviceId: '', credits: 0, lastSyncAt: 0 };
    // chatServerUrl → LLM relay (also used by claudeSettings.ts as baseURL)
    // userServerUrl → user management (auth, credits, payment)
    return { ...cloud, serverUrl: CHAT_SERVER_URL, chatServerUrl: CHAT_SERVER_URL, userServerUrl: USER_SERVER_URL };
  }

  private async updateCachedCredits(credits: number) {
    const cfg = this.getCloudConfig();
    await configService.updateConfig({
      cloud: { ...cfg, credits, lastSyncAt: Date.now() },
    });
  }

  private async updateCachedModel(modelId: string, modelName: string) {
    const cfg = this.getCloudConfig();
    if (cfg.modelId === modelId && cfg.modelName === modelName) return;
    await configService.updateConfig({ cloud: { ...cfg, modelId, modelName } });
  }

  private startSyncTimer() {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(() => {
      this.syncCredits().catch(() => {});
    }, CREDITS_SYNC_INTERVAL);
  }

  private stopSyncTimer() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private startFocusRefresh() {
    this.unsubWindowState = window.electron.window.onStateChanged((state) => {
      if (state.isFocused) {
        const now = Date.now();
        if (now - this.lastFocusRefreshTime > 30_000) {
          this.lastFocusRefreshTime = now;
          this.syncCredits().catch(() => {});
        }
      }
    });
  }

  private stopFocusRefresh() {
    this.unsubWindowState?.();
    this.unsubWindowState = null;
  }
}

export class CloudCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudCreditsError';
  }
}

export const cloudService = new CloudService();
