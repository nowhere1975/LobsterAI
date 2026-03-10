import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { CoworkConfig, CoworkExecutionMode } from '../coworkStore';
import type { DingTalkConfig, FeishuConfig, QQConfig, WecomConfig } from '../im/types';
import { resolveRawApiConfig } from './claudeSettings';
import type { OpenClawEngineManager } from './openclawEngineManager';

const mapExecutionModeToSandboxMode = (mode: CoworkExecutionMode): 'off' | 'non-main' | 'all' => {
  if (mode === 'local') return 'off';
  if (mode === 'sandbox') return 'all';
  return 'non-main';
};

const mapApiTypeToOpenClawApi = (apiType: 'anthropic' | 'openai' | undefined): 'anthropic-messages' | 'openai-completions' => {
  return apiType === 'openai' ? 'openai-completions' : 'anthropic-messages';
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const normalizeModelName = (modelId: string): string => {
  const trimmed = modelId.trim();
  if (!trimmed) return 'default-model';
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
};

const readPreinstalledPluginIds = (): string[] => {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const plugins = pkg.openclaw?.plugins;
    if (!Array.isArray(plugins)) return [];
    return plugins
      .map((p: { id?: string }) => p.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
};

export type OpenClawConfigSyncResult = {
  ok: boolean;
  changed: boolean;
  configPath: string;
  error?: string;
};

type OpenClawConfigSyncDeps = {
  engineManager: OpenClawEngineManager;
  getCoworkConfig: () => CoworkConfig;
  getDingTalkConfig: () => DingTalkConfig | null;
  getFeishuConfig: () => FeishuConfig | null;
  getQQConfig: () => QQConfig | null;
  getWecomConfig: () => WecomConfig | null;
};

export class OpenClawConfigSync {
  private readonly engineManager: OpenClawEngineManager;
  private readonly getCoworkConfig: () => CoworkConfig;
  private readonly getDingTalkConfig: () => DingTalkConfig | null;
  private readonly getFeishuConfig: () => FeishuConfig | null;
  private readonly getQQConfig: () => QQConfig | null;
  private readonly getWecomConfig: () => WecomConfig | null;

  constructor(deps: OpenClawConfigSyncDeps) {
    this.engineManager = deps.engineManager;
    this.getCoworkConfig = deps.getCoworkConfig;
    this.getDingTalkConfig = deps.getDingTalkConfig;
    this.getFeishuConfig = deps.getFeishuConfig;
    this.getQQConfig = deps.getQQConfig;
    this.getWecomConfig = deps.getWecomConfig;
  }

  sync(reason: string): OpenClawConfigSyncResult {
    const configPath = this.engineManager.getConfigPath();
    const coworkConfig = this.getCoworkConfig();
    const apiResolution = resolveRawApiConfig();

    if (!apiResolution.config) {
      return {
        ok: false,
        changed: false,
        configPath,
        error: apiResolution.error || 'OpenClaw config sync failed: model config is unavailable.',
      };
    }

    const { baseURL, apiKey, model, apiType } = apiResolution.config;
    const modelId = model.trim();
    if (!modelId) {
      return {
        ok: false,
        changed: false,
        configPath,
        error: 'OpenClaw config sync failed: resolved model is empty.',
      };
    }

    const providerModelName = normalizeModelName(modelId);
    const providerApi = mapApiTypeToOpenClawApi(apiType);
    const sandboxMode = mapExecutionModeToSandboxMode(coworkConfig.executionMode || 'auto');

    const workspaceDir = (coworkConfig.workingDirectory || '').trim();

    const preinstalledPluginIds = readPreinstalledPluginIds();

    const dingTalkConfig = this.getDingTalkConfig();
    const hasDingTalk = dingTalkConfig?.enabled && dingTalkConfig.clientId;
    const gatewayToken = hasDingTalk
      ? this.engineManager.getGatewayConnectionInfo().token || ''
      : '';

    const feishuConfig = this.getFeishuConfig();
    const hasFeishu = feishuConfig?.enabled && feishuConfig.appId;

    const qqConfig = this.getQQConfig();
    const hasQQ = qqConfig?.enabled && qqConfig.appId;

    const wecomConfig = this.getWecomConfig();
    const hasWecom = wecomConfig?.enabled && wecomConfig.botId;

    const hasAnyChannel = hasDingTalk || hasFeishu || hasQQ || hasWecom;

    const managedConfig: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        ...(hasAnyChannel ? {
          http: {
            endpoints: {
              chatCompletions: { enabled: true },
            },
          },
        } : {}),
      },
      models: {
        mode: 'replace',
        providers: {
          lobster: {
            baseUrl: baseURL,
            api: providerApi,
            apiKey,
            auth: 'api-key',
            models: [
              {
                id: modelId,
                name: providerModelName,
                api: providerApi,
                input: ['text'],
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: `lobster/${modelId}`,
          },
          sandbox: {
            mode: sandboxMode,
          },
          ...(workspaceDir ? { workspace: workspaceDir } : {}),
        },
      },
      ...(preinstalledPluginIds.length > 0
        ? {
            plugins: {
              entries: {
                ...Object.fromEntries(
                  preinstalledPluginIds.map((id) => [id, { enabled: true }]),
                ),
                // Disable the built-in feishu plugin when the official one is preinstalled
                ...(preinstalledPluginIds.includes('feishu-openclaw-plugin')
                  ? { feishu: { enabled: false } }
                  : {}),
              },
            },
          }
        : {}),
      ...(hasDingTalk ? {
        channels: {
          'dingtalk-connector': {
            enabled: true,
            clientId: dingTalkConfig.clientId,
            clientSecret: dingTalkConfig.clientSecret,
            ...(gatewayToken ? { gatewayToken } : {}),
          },
          ...(hasFeishu ? {
            feishu: {
              enabled: true,
              appId: feishuConfig.appId,
              appSecret: feishuConfig.appSecret,
              domain: feishuConfig.domain || 'feishu',
            },
          } : {}),
          ...(hasQQ ? {
            qqbot: {
              enabled: true,
              appId: qqConfig.appId,
              clientSecret: qqConfig.appSecret,
            },
          } : {}),
          ...(hasWecom ? {
            wecom: {
              enabled: true,
              botId: wecomConfig.botId,
              secret: wecomConfig.secret,
              dmPolicy: 'open',
            },
          } : {}),
        },
      } : hasFeishu ? {
        channels: {
          feishu: {
            enabled: true,
            appId: feishuConfig.appId,
            appSecret: feishuConfig.appSecret,
            domain: feishuConfig.domain || 'feishu',
          },
          ...(hasQQ ? {
            qqbot: {
              enabled: true,
              appId: qqConfig.appId,
              clientSecret: qqConfig.appSecret,
            },
          } : {}),
          ...(hasWecom ? {
            wecom: {
              enabled: true,
              botId: wecomConfig.botId,
              secret: wecomConfig.secret,
              dmPolicy: 'open',
            },
          } : {}),
        },
      } : hasQQ ? {
        channels: {
          qqbot: {
            enabled: true,
            appId: qqConfig.appId,
            clientSecret: qqConfig.appSecret,
          },
          ...(hasWecom ? {
            wecom: {
              enabled: true,
              botId: wecomConfig.botId,
              secret: wecomConfig.secret,
              dmPolicy: 'open',
            },
          } : {}),
        },
      } : hasWecom ? {
        channels: {
          wecom: {
            enabled: true,
            botId: wecomConfig.botId,
            secret: wecomConfig.secret,
          },
        },
      } : {}),
    };

    const nextContent = `${JSON.stringify(managedConfig, null, 2)}\n`;
    let currentContent = '';
    try {
      currentContent = fs.readFileSync(configPath, 'utf8');
    } catch {
      currentContent = '';
    }

    if (currentContent === nextContent) {
      return {
        ok: true,
        changed: false,
        configPath,
      };
    }

    try {
      ensureDir(path.dirname(configPath));
      const tmpPath = `${configPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, nextContent, 'utf8');
      fs.renameSync(tmpPath, configPath);
      return {
        ok: true,
        changed: true,
        configPath,
      };
    } catch (error) {
      return {
        ok: false,
        changed: false,
        configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
