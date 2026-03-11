/**
 * IM Gateway Manager
 * Unified manager for DingTalk, Feishu, NIM, Xiaomifeng gateways
 * and Telegram, Discord via OpenClaw
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { NimGateway } from './nimGateway';
import { XiaomifengGateway } from './xiaomifengGateway';
import { WecomGateway } from './wecomGateway';
import { IMChatHandler } from './imChatHandler';
import { IMCoworkHandler } from './imCoworkHandler';
import { IMStore } from './imStore';
import { fetchJsonWithTimeout } from './http';
import {
  IMGatewayConfig,
  IMGatewayStatus,
  IMPlatform,
  IMMessage,
  IMConnectivityCheck,
  IMConnectivityTestResult,
  IMConnectivityVerdict,
} from './types';
import type { Database } from 'sql.js';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import type { CoworkStore } from '../coworkStore';
const CONNECTIVITY_TIMEOUT_MS = 10_000;
const INBOUND_ACTIVITY_WARN_AFTER_MS = 2 * 60 * 1000;

interface TelegramGetMeResponse {
  ok?: boolean;
  result?: {
    username?: string;
  };
  description?: string;
}

interface DiscordUserResponse {
  username?: string;
  discriminator?: string;
}

export interface IMGatewayManagerOptions {
  coworkRuntime?: CoworkRuntime;
  coworkStore?: CoworkStore;
  ensureCoworkReady?: () => Promise<void>;
  isOpenClawEngine?: () => boolean;
  syncOpenClawConfig?: () => Promise<void>;
  ensureOpenClawGatewayConnected?: () => Promise<void>;
}

export class IMGatewayManager extends EventEmitter {
  private nimGateway: NimGateway;
  private xiaomifengGateway: XiaomifengGateway;
  private wecomGateway: WecomGateway;
  private imStore: IMStore;
  private chatHandler: IMChatHandler | null = null;
  private coworkHandler: IMCoworkHandler | null = null;
  private getLLMConfig: (() => Promise<any>) | null = null;
  private getSkillsPrompt: (() => Promise<string | null>) | null = null;
  private ensureCoworkReady: (() => Promise<void>) | null = null;
  private isOpenClawEngine: (() => boolean) | null = null;
  private syncOpenClawConfig: (() => Promise<void>) | null = null;
  private ensureOpenClawGatewayConnected: (() => Promise<void>) | null = null;

  // Cowork dependencies
  private coworkRuntime: CoworkRuntime | null = null;
  private coworkStore: CoworkStore | null = null;

  // NIM probe mutex: serializes concurrent connectivity tests
  private nimProbePromise: Promise<void> | null = null;

  constructor(db: Database, saveDb: () => void, options?: IMGatewayManagerOptions) {
    super();

    this.imStore = new IMStore(db, saveDb);
    this.nimGateway = new NimGateway();
    this.xiaomifengGateway = new XiaomifengGateway();
    this.wecomGateway = new WecomGateway();

    // Store Cowork dependencies if provided
    if (options?.coworkRuntime && options?.coworkStore) {
      this.coworkRuntime = options.coworkRuntime;
      this.coworkStore = options.coworkStore;
    }
    this.ensureCoworkReady = options?.ensureCoworkReady ?? null;
    this.isOpenClawEngine = options?.isOpenClawEngine ?? null;
    this.syncOpenClawConfig = options?.syncOpenClawConfig ?? null;
    this.ensureOpenClawGatewayConnected = options?.ensureOpenClawGatewayConnected ?? null;

    // Forward gateway events
    this.setupGatewayEventForwarding();
  }

  /**
   * Set up event forwarding from gateways
   */
  private setupGatewayEventForwarding(): void {
    // DingTalk runs via OpenClaw; no direct gateway events to forward

    // NIM events
    this.nimGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.nimGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.nimGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.nimGateway.on('error', (error) => {
      this.emit('error', { platform: 'nim', error });
      this.emit('statusChange', this.getStatus());
    });
    this.nimGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // Xiaomifeng events
    this.xiaomifengGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('error', (error) => {
      this.emit('error', { platform: 'xiaomifeng', error });
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // QQ runs via OpenClaw; no direct gateway events to forward

    // WeCom events
    this.wecomGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('error', (error) => {
      this.emit('error', { platform: 'wecom', error });
      this.emit('statusChange', this.getStatus());
    });
    this.wecomGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });
  }

  /**
   * Reconnect all disconnected gateways
   * Called when network is restored via IPC event
   */
  reconnectAllDisconnected(): void {
    console.log('[IMGatewayManager] Reconnecting all disconnected gateways...');

    // DingTalk runs via OpenClaw; no direct reconnect needed

    if (this.nimGateway && !this.nimGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting NIM...');
      this.nimGateway.reconnectIfNeeded();
    }

    if (this.xiaomifengGateway && !this.xiaomifengGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Xiaomifeng...');
      this.xiaomifengGateway.reconnectIfNeeded();
    }

    // QQ runs via OpenClaw; no direct reconnection needed

    if (this.wecomGateway && !this.wecomGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting WeCom...');
      this.wecomGateway.reconnectIfNeeded();
    }
  }

  /**
   * Initialize the manager with LLM and skills providers
   */
  initialize(options: {
    getLLMConfig: () => Promise<any>;
    getSkillsPrompt?: () => Promise<string | null>;
  }): void {
    this.getLLMConfig = options.getLLMConfig;
    this.getSkillsPrompt = options.getSkillsPrompt ?? null;

    // Set up message handlers for gateways
    this.setupMessageHandlers();
  }

  /**
   * Set up message handlers for both gateways
   */
  private setupMessageHandlers(): void {
    const messageHandler = async (
      message: IMMessage,
      replyFn: (text: string) => Promise<void>
    ): Promise<void> => {
      // Persist notification target whenever we receive a message
      this.persistNotificationTarget(message.platform);

      try {
        let response: string;

        // Always use Cowork mode if handler is available
        if (this.coworkHandler) {
          if (this.ensureCoworkReady) {
            await this.ensureCoworkReady();
          }
          console.log('[IMGatewayManager] Using Cowork mode for message processing');
          response = await this.coworkHandler.processMessage(message);
        } else {
          // Fallback to regular chat handler
          if (!this.chatHandler) {
            this.updateChatHandler();
          }

          if (!this.chatHandler) {
            throw new Error('Chat handler not available');
          }

          response = await this.chatHandler.processMessage(message);
        }

        await replyFn(response);
      } catch (error: any) {
        console.error(`[IMGatewayManager] Error processing message: ${error.message}`);
        // Don't send "Replaced by a newer IM request" error to user, just log it
        if (error.message === 'Replaced by a newer IM request') {
          return;
        }
        // Send error message to user
        try {
          await replyFn(`处理消息时出错: ${error.message}`);
        } catch (replyError) {
          console.error(`[IMGatewayManager] Failed to send error reply: ${replyError}`);
        }
      }
    };

    this.nimGateway.setMessageCallback(messageHandler);
    this.xiaomifengGateway.setMessageCallback(messageHandler);
    this.wecomGateway.setMessageCallback(messageHandler);
  }

  /**
   * Persist the notification target for a platform after receiving a message.
   */
  private persistNotificationTarget(platform: IMPlatform): void {
    try {
      let target: any = null;
      if (platform === 'nim') {
        target = this.nimGateway.getNotificationTarget();
      } else if (platform === 'wecom') {
        target = this.wecomGateway.getNotificationTarget();
      }
      if (target != null) {
        this.imStore.setNotificationTarget(platform, target);
      }
    } catch (err: any) {
      console.warn(`[IMGatewayManager] Failed to persist notification target for ${platform}:`, err.message);
    }
  }

  /**
   * Restore notification target from SQLite after gateway starts.
   */
  private restoreNotificationTarget(platform: IMPlatform): void {
    try {
      const target = this.imStore.getNotificationTarget(platform);
      if (target == null) return;

      if (platform === 'nim') {
        this.nimGateway.setNotificationTarget(target);
      } else if (platform === 'wecom') {
        this.wecomGateway.setNotificationTarget(target);
      }
      console.log(`[IMGatewayManager] Restored notification target for ${platform}`);
    } catch (err: any) {
      console.warn(`[IMGatewayManager] Failed to restore notification target for ${platform}:`, err.message);
    }
  }

  /**
   * Update chat handler with current settings
   */
  private updateChatHandler(): void {
    if (!this.getLLMConfig) {
      console.warn('[IMGatewayManager] LLM config provider not set');
      return;
    }

    const imSettings = this.imStore.getIMSettings();

    this.chatHandler = new IMChatHandler({
      getLLMConfig: this.getLLMConfig,
      getSkillsPrompt: this.getSkillsPrompt || undefined,
      imSettings,
    });

    // Update or create Cowork handler if dependencies are available
    this.updateCoworkHandler();
  }

  /**
   * Update or create Cowork handler
   * Always creates handler if dependencies are available (Cowork mode is always enabled for IM)
   */
  private updateCoworkHandler(): void {
    // Always create Cowork handler if we have the required dependencies
    if (this.coworkRuntime && this.coworkStore && !this.coworkHandler) {
      this.coworkHandler = new IMCoworkHandler({
        coworkRuntime: this.coworkRuntime,
        coworkStore: this.coworkStore,
        imStore: this.imStore,
        getSkillsPrompt: this.getSkillsPrompt || undefined,
      });
      console.log('[IMGatewayManager] Cowork handler created');
    }
  }

  // ==================== Configuration ====================

  /**
   * Get current configuration
   */
  getConfig(): IMGatewayConfig {
    return this.imStore.getConfig();
  }

  /**
   * Get the underlying IMStore instance (for session mapping operations)
   */
  getIMStore(): IMStore {
    return this.imStore;
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<IMGatewayConfig>): void {
    const previousConfig = this.imStore.getConfig();
    this.imStore.setConfig(config);

    // Update chat handler if settings changed
    if (config.settings) {
      this.updateChatHandler();
    }

    // Hot-update NIM config: if credential fields changed while gateway is connected,
    // restart the gateway transparently so the SDK re-logs in with new credentials.
    if (config.nim && this.nimGateway) {
      const oldNim = previousConfig.nim;
      const newNim = { ...oldNim, ...config.nim };
      const credentialsChanged =
        newNim.appKey !== oldNim.appKey ||
        newNim.account !== oldNim.account ||
        newNim.token !== oldNim.token;

      if (credentialsChanged && this.nimGateway.isConnected()) {
        console.log('[IMGatewayManager] NIM credentials changed, restarting gateway...');
        this.restartGateway('nim').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart NIM after config change:', err.message);
        });
      } else {
        // Hot-update non-credential fields (e.g. accountWhitelist) without restart
        const nonCredentialChanged =
          newNim.accountWhitelist !== oldNim.accountWhitelist;
        if (nonCredentialChanged) {
          console.log('[IMGatewayManager] NIM non-credential config changed, hot-updating...');
          this.nimGateway.updateConfig(config.nim);
        }
      }
    }

    // DingTalk now runs via OpenClaw; config sync is handled by IPC handler

    // Feishu now runs via OpenClaw; config sync is handled by IPC handler

    // Hot-update Xiaomifeng config: restart if credential fields changed
    if (config.xiaomifeng && this.xiaomifengGateway) {
      const oldXmf = previousConfig.xiaomifeng;
      const newXmf = { ...oldXmf, ...config.xiaomifeng };
      const credentialsChanged =
        newXmf.clientId !== oldXmf.clientId ||
        newXmf.secret !== oldXmf.secret;

      // Check if gateway is connected OR actively reconnecting (has pending timer)
      const isActiveOrReconnecting = this.xiaomifengGateway.isConnected() || this.xiaomifengGateway.isReconnecting();
      if (credentialsChanged && isActiveOrReconnecting) {
        console.log('[IMGatewayManager] Xiaomifeng credentials changed, restarting gateway...');
        this.restartGateway('xiaomifeng').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart Xiaomifeng after config change:', err.message);
        });
      }
    }

    // QQ runs via OpenClaw; config changes are synced via OpenClawConfigSync

    // Hot-update WeCom config: restart if credential fields changed
    if (config.wecom && this.wecomGateway) {
      const oldWc = previousConfig.wecom;
      const newWc = { ...oldWc, ...config.wecom };
      const credentialsChanged =
        newWc.botId !== oldWc.botId ||
        newWc.secret !== oldWc.secret;

      if (credentialsChanged && this.wecomGateway.isConnected()) {
        console.log('[IMGatewayManager] WeCom credentials changed, restarting gateway...');
        this.restartGateway('wecom').catch((err) => {
          console.error('[IMGatewayManager] Failed to restart WeCom after config change:', err.message);
        });
      }
    }
  }

  /**
   * Restart a specific gateway (stop then start with latest config)
   * Used for hot-reloading when credentials change at runtime.
   */
  private async restartGateway(platform: IMPlatform): Promise<void> {
    console.log(`[IMGatewayManager] Restarting ${platform} gateway...`);
    await this.stopGateway(platform);
    await this.startGateway(platform);
    console.log(`[IMGatewayManager] ${platform} gateway restarted successfully`);
  }

  // ==================== Status ====================

  /**
   * Get current status of all gateways
   */
  getStatus(): IMGatewayStatus {
    const config = this.getConfig();
    // Telegram runs via OpenClaw; reflect enabled+configured state as connected
    const tgConfig = config.telegram;
    const telegramStatus = {
      connected: Boolean(tgConfig?.enabled && tgConfig.botToken),
      startedAt: null as number | null,
      lastError: null as string | null,
      botUsername: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    // Discord runs via OpenClaw; reflect enabled+configured state as connected
    const dcConfig = config.discord;
    const discordStatus = {
      connected: Boolean(dcConfig?.enabled && dcConfig.botToken),
      starting: false,
      startedAt: null as number | null,
      lastError: null as string | null,
      botUsername: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    // DingTalk runs via OpenClaw; reflect enabled+configured state as connected
    const dtConfig = config.dingtalk;
    const dingtalkStatus = {
      connected: Boolean(dtConfig?.enabled && dtConfig.clientId && dtConfig.clientSecret),
      startedAt: null as number | null,
      lastError: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    // Feishu runs via OpenClaw; reflect enabled+configured state as connected
    const fsConfig = config.feishu;
    const feishuStatus = {
      connected: Boolean(fsConfig?.enabled && fsConfig.appId && fsConfig.appSecret),
      startedAt: null as string | null,
      botOpenId: null as string | null,
      error: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    return {
      dingtalk: dingtalkStatus,
      feishu: feishuStatus,
      telegram: telegramStatus,
      qq: {
        connected: Boolean(config.qq?.enabled && config.qq.appId && config.qq.appSecret),
        startedAt: null as number | null,
        lastError: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      },
      discord: discordStatus,
      nim: this.nimGateway.getStatus(),
      xiaomifeng: this.xiaomifengGateway.getStatus(),
      wecom: this.wecomGateway.getStatus(),
    };
  }

  /**
   * Test platform connectivity and readiness for conversation.
   */
  async testGateway(
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    // Telegram always uses OpenClaw mode
    if (platform === 'telegram') {
      return this.testTelegramOpenClawConnectivity(configOverride);
    }

    // Discord always uses OpenClaw mode
    if (platform === 'discord') {
      return this.testDiscordOpenClawConnectivity(configOverride);
    }

    // Feishu always uses OpenClaw mode
    if (platform === 'feishu') {
      return this.testFeishuOpenClawConnectivity(configOverride);
    }

    // DingTalk always uses OpenClaw mode
    if (platform === 'dingtalk') {
      return this.testDingTalkOpenClawConnectivity(configOverride);
    }

    const config = this.buildMergedConfig(configOverride);
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();

    const addCheck = (check: IMConnectivityCheck) => {
      checks.push(check);
    };

    const missingCredentials = this.getMissingCredentials(platform, config);
    if (missingCredentials.length > 0) {
      addCheck({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missingCredentials.join(', ')}`,
        suggestion: '请补全配置后重新测试连通性。',
      });

      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    try {
      const authMessage = await this.withTimeout(
        this.runAuthProbe(platform, config),
        CONNECTIVITY_TIMEOUT_MS,
        '鉴权探测超时'
      );
      addCheck({
        code: 'auth_check',
        level: 'pass',
        message: authMessage,
      });
    } catch (error: any) {
      addCheck({
        code: 'auth_check',
        level: 'fail',
        message: `鉴权失败: ${error.message}`,
        suggestion: '请检查 ID/Secret/Token 是否正确，且机器人权限已开通。',
      });
      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    const status = this.getStatus();
    const enabled = Boolean(config[platform]?.enabled);
    const connected = this.isConnected(platform);

    if (enabled && !connected) {
      addCheck({
        code: 'gateway_running',
        level: 'warn',
        message: 'IM 渠道已启用但当前未连接。',
        suggestion: '请检查网络、机器人配置和平台侧事件开关。',
      });
    } else {
      addCheck({
        code: 'gateway_running',
        level: connected ? 'pass' : 'info',
        message: connected ? 'IM 渠道已启用且运行正常。' : 'IM 渠道当前未启用。',
        suggestion: connected ? undefined : '请点击对应 IM 渠道胶囊按钮启用该渠道。',
      });
    }

    const startedAt = this.getStartedAtMs(platform, status);
    const lastInboundAt = this.getLastInboundAt(platform, status);
    const lastOutboundAt = this.getLastOutboundAt(platform, status);

    if (connected && startedAt && testedAt - startedAt >= INBOUND_ACTIVITY_WARN_AFTER_MS) {
      if (!lastInboundAt) {
        addCheck({
          code: 'inbound_activity',
          level: 'warn',
          message: '已连接超过 2 分钟，但尚未收到任何入站消息。',
          suggestion: '请确认机器人已在目标会话中，或按平台规则 @机器人 触发消息。',
        });
      } else {
        addCheck({
          code: 'inbound_activity',
          level: 'pass',
          message: '已检测到入站消息。',
        });
      }
    } else if (connected) {
      addCheck({
        code: 'inbound_activity',
        level: 'info',
        message: '网关刚启动，入站活动检查将在 2 分钟后更准确。',
      });
    }

    if (connected && lastInboundAt) {
      if (!lastOutboundAt) {
        addCheck({
          code: 'outbound_activity',
          level: 'warn',
          message: '已收到消息，但尚未观察到成功回发。',
          suggestion: '请检查消息发送权限、机器人可见范围和会话回包权限。',
        });
      } else {
        addCheck({
          code: 'outbound_activity',
          level: 'pass',
          message: '已检测到成功回发消息。',
        });
      }
    } else if (connected) {
      addCheck({
        code: 'outbound_activity',
        level: 'info',
        message: '尚未收到可用于评估回发能力的入站消息。',
      });
    }

    const lastError = this.getLastError(platform, status);
    if (lastError) {
      addCheck({
        code: 'platform_last_error',
        level: connected ? 'warn' : 'fail',
        message: `最近错误: ${lastError}`,
        suggestion: connected
          ? '当前已连接，但建议修复该错误避免后续中断。'
          : '该错误可能阻断对话，请优先修复后重试。',
      });
    }

    if (platform === 'nim') {
      addCheck({
        code: 'nim_p2p_only_hint',
        level: 'info',
        message: '云信 IM 当前仅支持 P2P（私聊）消息。',
        suggestion: '请通过私聊方式向机器人账号发送消息触发对话。',
      });
    } else if (platform === 'qq') {
      addCheck({
        code: 'qq_guild_mention_hint',
        level: 'info',
        message: 'QQ 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
        suggestion: '频道中需 @机器人 触发对话，也支持私信和群聊。',
      });
    } else if (platform === 'wecom') {
      addCheck({
        code: 'nim_p2p_only_hint',
        level: 'info',
        message: '企业微信机器人通过 WebSocket 长连接接收消息。',
        suggestion: '请在企业微信中向机器人发送消息触发对话。群聊中需 @机器人。',
      });
    }

    return {
      platform,
      testedAt,
      verdict: this.calculateVerdict(checks),
      checks,
    };
  }

  // ==================== Gateway Control ====================

  /**
   * Start a specific gateway
   */
  async startGateway(platform: IMPlatform): Promise<void> {
    const config = this.getConfig();

    // Ensure chat handler is ready
    this.updateChatHandler();

    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw gateway (dingtalk-connector plugin)
      console.log('[IMGatewayManager] DingTalk in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'feishu') {
      // Feishu runs via OpenClaw gateway (feishu-openclaw-plugin)
      console.log('[IMGatewayManager] Feishu in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'telegram') {
      // Telegram always runs via OpenClaw gateway
      console.log('[IMGatewayManager] Telegram in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      // Connect the gateway WebSocket so channel events (e.g. Telegram messages) are received
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'discord') {
      // Discord runs via OpenClaw gateway
      console.log('[IMGatewayManager] Discord in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'nim') {
      await this.nimGateway.start(config.nim);
    } else if (platform === 'xiaomifeng') {
      await this.xiaomifengGateway.start(config.xiaomifeng);
    } else if (platform === 'qq') {
      // QQ runs via OpenClaw gateway (qqbot plugin)
      console.log('[IMGatewayManager] QQ in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'wecom') {
      await this.wecomGateway.start(config.wecom);
    }

    // Restore persisted notification target
    this.restoreNotificationTarget(platform);
  }

  /**
   * Stop a specific gateway
   */
  async stopGateway(platform: IMPlatform): Promise<void> {
    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw gateway
      console.log('[IMGatewayManager] DingTalk in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'feishu') {
      // Feishu runs via OpenClaw gateway
      console.log('[IMGatewayManager] Feishu in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'telegram') {
      // Telegram always runs via OpenClaw gateway
      console.log('[IMGatewayManager] Telegram in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'discord') {
      // Discord runs via OpenClaw gateway
      console.log('[IMGatewayManager] Discord in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'nim') {
      await this.nimGateway.stop();
    } else if (platform === 'xiaomifeng') {
      await this.xiaomifengGateway.stop();
    } else if (platform === 'qq') {
      // QQ runs via OpenClaw gateway
      console.log('[IMGatewayManager] QQ in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'wecom') {
      await this.wecomGateway.stop();
    }
  }

  /**
   * Start all enabled gateways
   */
  async startAllEnabled(): Promise<void> {
    const config = this.getConfig();

    if (config.dingtalk.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret) {
      try {
        await this.startGateway('dingtalk');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start DingTalk: ${error.message}`);
      }
    }

    if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
      try {
        await this.startGateway('feishu');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Feishu: ${error.message}`);
      }
    }

    if (config.telegram?.enabled && config.telegram.botToken) {
      try {
        await this.startGateway('telegram');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Telegram (OpenClaw): ${error.message}`);
      }
    }

    if (config.discord.enabled && config.discord.botToken) {
      try {
        await this.startGateway('discord');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Discord: ${error.message}`);
      }
    }

    if (config.nim.enabled && config.nim.appKey && config.nim.account && config.nim.token) {
      try {
        await this.startGateway('nim');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start NIM: ${error.message}`);
      }
    }

    if (config.xiaomifeng?.enabled && config.xiaomifeng?.clientId && config.xiaomifeng?.secret) {
      try {
        await this.startGateway('xiaomifeng');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Xiaomifeng: ${error.message}`);
      }
    }

    if (config.qq?.enabled && config.qq?.appId && config.qq?.appSecret) {
      try {
        await this.startGateway('qq');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start QQ: ${error.message}`);
      }
    }

    if (config.wecom?.enabled && config.wecom?.botId && config.wecom?.secret) {
      try {
        await this.startGateway('wecom');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start WeCom: ${error.message}`);
      }
    }
  }

  /**
   * Stop all gateways
   */
  async stopAll(): Promise<void> {
    await Promise.all([
      this.nimGateway.stop(),
      this.xiaomifengGateway.stop(),
      this.wecomGateway.stop(),
    ]);
  }

  /**
   * Check if any gateway is connected
   */
  isAnyConnected(): boolean {
    return this.nimGateway.isConnected() || this.xiaomifengGateway.isConnected() || this.wecomGateway.isConnected();
  }

  /**
   * Check if a specific gateway is connected
   */
  isConnected(platform: IMPlatform): boolean {
    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.dingtalk?.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret);
    }
    if (platform === 'telegram') {
      // Telegram runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.telegram?.enabled && config.telegram.botToken);
    }
    if (platform === 'discord') {
      // Discord runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.discord?.enabled && config.discord.botToken);
    }
    if (platform === 'nim') {
      return this.nimGateway.isConnected();
    }
    if (platform === 'xiaomifeng') {
      return this.xiaomifengGateway.isConnected();
    }
    if (platform === 'qq') {
      // QQ runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.qq?.enabled && config.qq.appId && config.qq.appSecret);
    }
    if (platform === 'wecom') {
      return this.wecomGateway.isConnected();
    }
    return false;
  }

  /**
   * Send a notification message through a specific platform.
   * Uses platform-specific broadcast mechanisms.
   * Returns true if successfully sent, false if platform not connected.
   */
  async sendNotification(platform: IMPlatform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'nim') {
        await this.nimGateway.sendNotification(text);
      } else if (platform === 'qq') {
        // QQ runs via OpenClaw; notifications are handled by the qqbot plugin
        console.log('[IMGatewayManager] QQ notification via OpenClaw not yet supported');
      } else if (platform === 'wecom') {
        await this.wecomGateway.sendNotification(text);
      } else if (platform === 'xiaomifeng') {
        await this.xiaomifengGateway.sendNotification(text);
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification via ${platform}:`, error.message);
      return false;
    }
  }

  async sendNotificationWithMedia(platform: IMPlatform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'nim') {
        await this.nimGateway.sendNotificationWithMedia(text);
      } else if (platform === 'qq') {
        // QQ runs via OpenClaw; notifications are handled by the qqbot plugin
        console.log('[IMGatewayManager] QQ notification with media via OpenClaw not yet supported');
      } else if (platform === 'wecom') {
        await this.wecomGateway.sendNotificationWithMedia(text);
      } else if (platform === 'xiaomifeng') {
        await this.xiaomifengGateway.sendNotificationWithMedia(text);
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification with media via ${platform}:`, error.message);
      return false;
    }
  }

  /**
   * Test Telegram connectivity when running via OpenClaw runtime.
   * Validates bot token via Telegram API (same auth probe as direct mode).
   */
  private async testTelegramOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: IMPlatform = 'telegram';

    // Resolve the Telegram config (now TelegramOpenClawConfig type)
    const mergedConfig = this.buildMergedConfig(configOverride);
    const tgConfig = mergedConfig.telegram;
    const botToken = tgConfig?.botToken || '';

    // Check 1: Bot token present
    if (!botToken) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: '缺少必要配置项: botToken',
        suggestion: '请补全 Bot Token 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via Telegram API (getMe)
    try {
      const response = await this.withTimeout(
        fetchJsonWithTimeout<TelegramGetMeResponse>(
          `https://api.telegram.org/bot${botToken}/getMe`,
          {},
          CONNECTIVITY_TIMEOUT_MS
        ),
        CONNECTIVITY_TIMEOUT_MS,
        '鉴权探测超时'
      );
      if (response?.ok && response.result?.username) {
        checks.push({
          code: 'auth_check',
          level: 'pass',
          message: `Telegram Bot 鉴权通过: @${response.result.username}`,
        });
      } else {
        checks.push({
          code: 'auth_check',
          level: 'fail',
          message: `Telegram Bot 鉴权失败: ${response?.description || '未知错误'}`,
          suggestion: '请检查 Bot Token 是否正确。',
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `Telegram Bot 鉴权失败: ${error.message}`,
        suggestion: '请检查 Bot Token 是否正确，且网络通畅。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: 'Telegram 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  /**
   * Test Discord connectivity when running via OpenClaw runtime.
   * Validates bot token via Discord API (/users/@me).
   */
  private async testDiscordOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: IMPlatform = 'discord';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const dcConfig = mergedConfig.discord;
    const botToken = dcConfig?.botToken || '';

    // Check 1: Bot token present
    if (!botToken) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: '缺少必要配置项: botToken',
        suggestion: '请补全 Bot Token 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via Discord API (/users/@me)
    try {
      const response = await this.withTimeout(
        fetchJsonWithTimeout<DiscordUserResponse>(
          'https://discord.com/api/v10/users/@me',
          { headers: { Authorization: `Bot ${botToken}` } },
          CONNECTIVITY_TIMEOUT_MS
        ),
        CONNECTIVITY_TIMEOUT_MS,
        '鉴权探测超时'
      );
      const username = response?.username
        ? `${response.username}${response.discriminator && response.discriminator !== '0' ? `#${response.discriminator}` : ''}`
        : 'unknown';
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: `Discord Bot 鉴权通过（Bot: ${username}）。`,
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `Discord Bot 鉴权失败: ${error.message}`,
        suggestion: '请检查 Bot Token 是否正确，且网络通畅。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: 'Discord 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    // Check 4: Group mention hint
    checks.push({
      code: 'discord_group_requires_mention',
      level: 'info',
      message: 'Discord 群聊中仅响应 @机器人的消息。',
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  /**
   * Test Feishu connectivity when running via OpenClaw runtime (feishu-openclaw-plugin).
   * Validates credentials via Feishu API (/open-apis/bot/v3/info).
   */
  private async testFeishuOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: IMPlatform = 'feishu';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const fsConfig = mergedConfig.feishu;

    // Check 1: Credentials present
    if (!fsConfig?.appId || !fsConfig?.appSecret) {
      const missing: string[] = [];
      if (!fsConfig?.appId) missing.push('appId');
      if (!fsConfig?.appSecret) missing.push('appSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: '请补全 App ID 和 App Secret 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via Feishu API
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(fsConfig.domain, Lark);
      const client = new Lark.Client({
        appId: fsConfig.appId,
        appSecret: fsConfig.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });
      const response: any = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      const botName = response.data?.app_name ?? response.data?.bot?.app_name ?? 'unknown';
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: `飞书鉴权通过（Bot: ${botName}）`,
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `飞书鉴权失败: ${error.message}`,
        suggestion: '请检查 App ID 和 App Secret 是否正确。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: '飞书通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    // Check 4: Group mention hint
    checks.push({
      code: 'feishu_group_requires_mention',
      level: 'info',
      message: '飞书群聊中仅响应 @机器人的消息。',
      suggestion: '请在群聊中使用 @机器人 + 内容触发对话。',
    });

    // Check 5: Event subscription hint
    checks.push({
      code: 'feishu_event_subscription_required',
      level: 'info',
      message: '飞书需要开启消息事件订阅（im.message.receive_v1）才能收消息。',
      suggestion: '请在飞书开发者后台确认事件订阅、权限和发布状态。',
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  /**
   * Test DingTalk connectivity when running via OpenClaw runtime.
   * Validates credentials via DingTalk API.
   */
  private async testDingTalkOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: IMPlatform = 'dingtalk';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const dtConfig = mergedConfig.dingtalk;

    // Check 1: Credentials present
    if (!dtConfig?.clientId || !dtConfig?.clientSecret) {
      const missing: string[] = [];
      if (!dtConfig?.clientId) missing.push('clientId');
      if (!dtConfig?.clientSecret) missing.push('clientSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: '请补全 Client ID 和 Client Secret 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via DingTalk API
    try {
      const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(dtConfig.clientId)}&appsecret=${encodeURIComponent(dtConfig.clientSecret)}`;
      const resp = await this.withTimeout(
        fetchJsonWithTimeout<{ errcode?: number; errmsg?: string; access_token?: string }>(tokenUrl, {}, CONNECTIVITY_TIMEOUT_MS),
        CONNECTIVITY_TIMEOUT_MS,
        '鉴权探测超时'
      );
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(resp.errmsg || `errcode ${resp.errcode}`);
      }
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: '钉钉鉴权通过。',
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `钉钉鉴权失败: ${error.message}`,
        suggestion: '请检查 Client ID 和 Client Secret 是否正确，且机器人权限已开通。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: '钉钉通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    // Check 4: Bot membership hint
    checks.push({
      code: 'dingtalk_bot_membership_hint',
      level: 'info',
      message: '钉钉机器人需被加入目标会话并具备发言权限。',
      suggestion: '请确认机器人在目标会话中，且企业权限配置允许收发消息。',
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private buildMergedConfig(configOverride?: Partial<IMGatewayConfig>): IMGatewayConfig {
    const current = this.getConfig();
    if (!configOverride) {
      return current;
    }
    return {
      ...current,
      ...configOverride,
      dingtalk: { ...current.dingtalk, ...(configOverride.dingtalk || {}) },
      feishu: { ...current.feishu, ...(configOverride.feishu || {}) },
      qq: { ...current.qq, ...(configOverride.qq || {}) },
      telegram: { ...current.telegram, ...(configOverride.telegram || {}) },
      discord: { ...current.discord, ...(configOverride.discord || {}) },
      nim: { ...current.nim, ...(configOverride.nim || {}) },
      xiaomifeng: { ...current.xiaomifeng, ...(configOverride.xiaomifeng || {}) },
      wecom: { ...current.wecom, ...(configOverride.wecom || {}) },
      settings: { ...current.settings, ...(configOverride.settings || {}) },
    };
  }

  private getMissingCredentials(platform: IMPlatform, config: IMGatewayConfig): string[] {
    if (platform === 'dingtalk') {
      const fields: string[] = [];
      if (!config.dingtalk.clientId) fields.push('clientId');
      if (!config.dingtalk.clientSecret) fields.push('clientSecret');
      return fields;
    }
    if (platform === 'feishu') {
      const fields: string[] = [];
      if (!config.feishu.appId) fields.push('appId');
      if (!config.feishu.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'telegram') {
      return config.telegram.botToken ? [] : ['botToken'];
    }
    if (platform === 'nim') {
      const fields: string[] = [];
      if (!config.nim.appKey) fields.push('appKey');
      if (!config.nim.account) fields.push('account');
      if (!config.nim.token) fields.push('token');
      return fields;
    }
    if (platform === 'xiaomifeng') {
      const fields: string[] = [];
      if (!config.xiaomifeng?.clientId) fields.push('clientId');
      if (!config.xiaomifeng?.secret) fields.push('secret');
      return fields;
    }
    if (platform === 'qq') {
      const fields: string[] = [];
      if (!config.qq?.appId) fields.push('appId');
      if (!config.qq?.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'wecom') {
      const fields: string[] = [];
      if (!config.wecom?.botId) fields.push('botId');
      if (!config.wecom?.secret) fields.push('secret');
      return fields;
    }
    return config.discord.botToken ? [] : ['botToken'];
  }

  private async runAuthProbe(platform: IMPlatform, config: IMGatewayConfig): Promise<string> {
    if (platform === 'dingtalk') {
      const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(config.dingtalk.clientId)}&appsecret=${encodeURIComponent(config.dingtalk.clientSecret)}`;
      const resp = await fetchJsonWithTimeout<{ errcode?: number; errmsg?: string }>(tokenUrl, {}, CONNECTIVITY_TIMEOUT_MS);
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(resp.errmsg || `errcode ${resp.errcode}`);
      }
      return '钉钉鉴权通过。';
    }

    if (platform === 'feishu') {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(config.feishu.domain, Lark);
      const client = new Lark.Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });
      const response: any = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      const botName = response.data?.app_name ?? response.data?.bot?.app_name ?? 'unknown';
      return `飞书鉴权通过（Bot: ${botName}）。`;
    }

    if (platform === 'nim') {
      // Use an isolated temporary NimGateway instance so the probe never
      // touches the main gateway's state and never fires onMessageCallback.
      await this.testNimConnectivity(config.nim);
      return `云信鉴权通过（Account: ${config.nim.account}，SDK 登录成功）。`;
    }

    if (platform === 'xiaomifeng') {
      // 小蜜蜂使用网易云信 NIM SDK，鉴权是通过 SDK 登录验证的
      // 这里我们只做配置完整性检查，实际登录验证在 start 时进行
      const { clientId, secret } = config.xiaomifeng;
      if (!clientId || !secret) {
        throw new Error('配置不完整');
      }
      return `小蜜蜂配置已就绪（Client ID: ${clientId}）。`;
    }

    if (platform === 'wecom') {
      const { botId, secret } = config.wecom;
      if (!botId || !secret) {
        throw new Error('配置不完整');
      }
      // Create a temporary WSClient to verify authentication
      const { WSClient } = await import('@wecom/aibot-node-sdk');
      const tmpClient = new WSClient({ botId, secret, maxReconnectAttempts: 0 });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('企业微信鉴权超时（10s）'));
          }, CONNECTIVITY_TIMEOUT_MS);
          tmpClient.on('authenticated', () => {
            clearTimeout(timer);
            resolve();
          });
          tmpClient.on('error', (err: Error) => {
            clearTimeout(timer);
            reject(err);
          });
          tmpClient.connect();
        });
        return `企业微信鉴权通过（Bot ID: ${botId}）。`;
      } finally {
        try { tmpClient.disconnect(); } catch (_) { /* ignore */ }
      }
    }

    if (platform === 'qq') {
      const { appId, appSecret } = config.qq;
      if (!appId || !appSecret) {
        throw new Error('配置不完整');
      }
      // Verify credentials by requesting an AccessToken directly via HTTP
      // This avoids starting a full WebSocket connection just for auth check
      const tokenResponse = await fetchJsonWithTimeout<{ access_token?: string; expires_in?: number; code?: number; message?: string }>(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: appSecret }),
        },
        CONNECTIVITY_TIMEOUT_MS
      );
      if (!tokenResponse.access_token) {
        throw new Error(tokenResponse.message || '获取 AccessToken 失败');
      }
      return `QQ 鉴权通过（AccessToken 已获取）。`;
    }

    return '未知平台。';
  }

  /**
   * Test NIM connectivity.
   *
   * NIM enforces single-device login per account: if a second client logs in
   * with the same account, the first one is kicked offline. Therefore we CANNOT
   * create a temporary NimGateway alongside the main one.
   *
   * Strategy:
   * 1. If the main nimGateway is already connected → credentials are valid,
   *    return immediately.
   * 2. Otherwise, **stop the main gateway first** (if it has a stale SDK
   *    instance), then create a temporary probe instance with its own data
   *    path. After the probe completes, fully stop it, then **restart the
   *    main gateway** so normal message reception resumes.
   */
  private async testNimConnectivity(nimConfig: IMGatewayConfig['nim']): Promise<void> {
    // Fast path: if the main gateway is already connected, credentials are valid.
    if (this.nimGateway.isConnected()) {
      return;
    }

    // Mutex: if a previous probe is still running, wait for it to finish first
    // to avoid concurrent NIM SDK instances causing native crashes.
    if (this.nimProbePromise) {
      try {
        await this.nimProbePromise;
      } catch (_) { /* ignore previous probe errors */ }
    }

    // Wrap the actual probe in a tracked promise for mutex
    this.nimProbePromise = this.executeNimProbe(nimConfig);
    try {
      await this.nimProbePromise;
    } finally {
      this.nimProbePromise = null;
    }
  }

  /**
   * Internal NIM probe execution (called under mutex protection).
   */
  private async executeNimProbe(nimConfig: IMGatewayConfig['nim']): Promise<void> {
    // Stop the main gateway before probing to avoid kick-offline conflicts.
    // This is a no-op if it's not running.
    try {
      await this.nimGateway.stop();
    } catch (_) { /* ignore */ }

    // Wait for native SDK resources to be fully released before creating a new instance.
    await new Promise(resolve => setTimeout(resolve, 500));

    const NIM_TEST_TIMEOUT_MS = 9_000;
    let tmpGateway: NimGateway | null = new NimGateway();

    // Use a unique temporary data path to avoid file-lock conflicts.
    const tmpDataPath = path.join(
      os.tmpdir(),
      `lobsterai-nim-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    fs.mkdirSync(tmpDataPath, { recursive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('NIM 登录超时（9s），请检查网络或凭据'));
        }, NIM_TEST_TIMEOUT_MS);

        tmpGateway!.once('connected', () => {
          clearTimeout(timer);
          resolve();
        });

        tmpGateway!.once('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });

        // Also listen for loginFailed which may not always emit 'error'
        tmpGateway!.once('loginFailed', (err: any) => {
          clearTimeout(timer);
          const desc = err?.desc || err?.message || JSON.stringify(err);
          reject(new Error(`NIM 登录失败: ${desc}`));
        });

        tmpGateway!.start(
          { ...nimConfig, enabled: true },
          { appDataPathOverride: tmpDataPath }
        ).catch(reject);
      });
    } finally {
      // Fully stop the temporary instance before doing anything else.
      if (tmpGateway) {
        const gw = tmpGateway;
        tmpGateway = null;
        try {
          await gw.stop();
        } catch (stopErr: any) {
          // Ensure uninit failures never propagate as uncaught exceptions
          console.warn('[IMGatewayManager] NIM probe tmpGateway.stop() error (ignored):', stopErr?.message || stopErr);
        }
      }

      // Wait for native cleanup before restarting the main gateway.
      await new Promise(resolve => setTimeout(resolve, 500));

      // Clean up the temporary data directory after a short delay.
      setTimeout(() => {
        try {
          fs.rmSync(tmpDataPath, { recursive: true, force: true });
        } catch (_) { /* ignore */ }
      }, 2000);

      // Restart the main gateway if the NIM config says it should be enabled
      // so that normal message reception resumes.
      // We restart regardless of probe success: even if the probe failed,
      // the main gateway was stopped and needs to be restarted if enabled.
      if (nimConfig.enabled) {
        try {
          await this.startGateway('nim');
        } catch (err: any) {
          console.error('[IMGatewayManager] Failed to restart main NIM gateway after probe:', err.message);
        }
      }
    }
  }

  private resolveFeishuDomain(domain: string, Lark: any): any {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu') return Lark.Domain.Feishu;
    return domain.replace(/\/+$/, '');
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  private getStartedAtMs(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'feishu') {
      return status.feishu.startedAt ? Date.parse(status.feishu.startedAt) : null;
    }
    if (platform === 'dingtalk') return status.dingtalk.startedAt;
    if (platform === 'telegram') return status.telegram.startedAt;
    if (platform === 'nim') return status.nim.startedAt;
    if (platform === 'xiaomifeng') return status.xiaomifeng.startedAt;
    if (platform === 'qq') return status.qq.startedAt;
    if (platform === 'wecom') return status.wecom.startedAt;
    return status.discord.startedAt;
  }

  private getLastInboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastInboundAt;
    if (platform === 'feishu') return status.feishu.lastInboundAt;
    if (platform === 'telegram') return status.telegram.lastInboundAt;
    if (platform === 'nim') return status.nim.lastInboundAt;
    if (platform === 'xiaomifeng') return status.xiaomifeng.lastInboundAt;
    if (platform === 'qq') return status.qq.lastInboundAt;
    if (platform === 'wecom') return status.wecom.lastInboundAt;
    return status.discord.lastInboundAt;
  }

  private getLastOutboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastOutboundAt;
    if (platform === 'feishu') return status.feishu.lastOutboundAt;
    if (platform === 'telegram') return status.telegram.lastOutboundAt;
    if (platform === 'nim') return status.nim.lastOutboundAt;
    if (platform === 'xiaomifeng') return status.xiaomifeng.lastOutboundAt;
    if (platform === 'qq') return status.qq.lastOutboundAt;
    if (platform === 'wecom') return status.wecom.lastOutboundAt;
    return status.discord.lastOutboundAt;
  }

  private getLastError(platform: IMPlatform, status: IMGatewayStatus): string | null {
    if (platform === 'dingtalk') return status.dingtalk.lastError;
    if (platform === 'feishu') return status.feishu.error;
    if (platform === 'telegram') return status.telegram.lastError;
    if (platform === 'nim') return status.nim.lastError;
    if (platform === 'xiaomifeng') return status.xiaomifeng.lastError;
    if (platform === 'qq') return status.qq.lastError;
    if (platform === 'wecom') return status.wecom.lastError;
    return status.discord.lastError;
  }

  private calculateVerdict(checks: IMConnectivityCheck[]): IMConnectivityVerdict {
    if (checks.some((check) => check.level === 'fail')) {
      return 'fail';
    }
    if (checks.some((check) => check.level === 'warn')) {
      return 'warn';
    }
    return 'pass';
  }
}
