import React, { useState, useCallback } from 'react';
import { i18nService } from '../services/i18n';
import { configService } from '../services/config';
import { cloudService } from '../services/cloudService';
import { AppConfig } from '../config';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/20/solid';
import { ChevronRightIcon, ChevronDownIcon } from '@heroicons/react/24/outline';

interface Provider {
  key: string;
  label: string;
  baseUrl: string;
  apiFormat: 'anthropic' | 'openai';
  defaultModel: string;
  defaultModelName: string;
  getKeyUrl: string;
}

const PROVIDERS: Provider[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiFormat: 'anthropic',
    defaultModel: 'deepseek-chat',
    defaultModelName: 'DeepSeek Chat',
    getKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'moonshot',
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    apiFormat: 'anthropic',
    defaultModel: 'kimi-k2.5',
    defaultModelName: 'Kimi K2.5',
    getKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    key: 'qwen',
    label: '通义千问（阿里云）',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    apiFormat: 'anthropic',
    defaultModel: 'qwen3.5-plus',
    defaultModelName: 'Qwen3.5 Plus',
    getKeyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiFormat: 'anthropic',
    defaultModel: 'glm-4.7',
    defaultModelName: 'GLM 4.7',
    getKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    key: 'volcengine',
    label: '豆包（字节跳动）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    apiFormat: 'anthropic',
    defaultModel: 'doubao-seed-2-0-pro-260215',
    defaultModelName: 'Doubao-Seed-2.0-pro',
    getKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
];

interface SetupWizardProps {
  onComplete: () => void;
}

const SetupWizard: React.FC<SetupWizardProps> = ({ onComplete }) => {
  const t = useCallback((key: string) => i18nService.t(key), []);

  // 云额度状态
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);

  // API Key 折叠区状态
  const [keyExpanded, setKeyExpanded] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState('');

  // 领取首次登录奖励
  const handleClaim = useCallback(async () => {
    setClaiming(true);
    try {
      await cloudService.enable();
      setClaimed(true);
    } finally {
      setClaiming(false);
    }
  }, []);

  // 保存自带 API Key
  const handleSaveKey = useCallback(async () => {
    if (!selectedProvider) return;
    if (!apiKey.trim()) {
      setKeyError(t('setupWizardApiKeyEmpty'));
      return;
    }
    setSaving(true);
    setKeyError('');
    try {
      const config = configService.getConfig();
      const providers = { ...(config.providers ?? {}) };
      providers[selectedProvider.key] = {
        ...(providers[selectedProvider.key] ?? {}),
        enabled: true,
        apiKey: apiKey.trim(),
        baseUrl: selectedProvider.baseUrl,
        apiFormat: selectedProvider.apiFormat,
        models: providers[selectedProvider.key]?.models ?? [
          { id: selectedProvider.defaultModel, name: selectedProvider.defaultModelName },
        ],
      };
      await configService.updateConfig({
        providers: providers as AppConfig['providers'],
        model: {
          ...config.model,
          defaultModel: selectedProvider.defaultModel,
          defaultModelProvider: selectedProvider.key,
        },
      });
      onComplete();
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, apiKey, t, onComplete]);

  const handleOpenUrl = useCallback((url: string) => {
    window.electron.shell.openExternal(url);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-md mx-4 rounded-2xl shadow-2xl dark:bg-claude-darkSurface bg-white overflow-hidden">

        {/* Logo header */}
        <div className="flex flex-col items-center pt-8 pb-4 px-8">
          <img src="/logo.png" alt="UdiskAI" className="w-14 h-14 rounded-2xl mb-3 shadow-md" />
          <h1 className="text-xl font-bold dark:text-claude-darkText text-claude-text">UdiskAI</h1>
          <p className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted mt-1">你的随身 AI 办公助手</p>
        </div>

        <div className="px-6 pb-6 space-y-3">

          {/* ── 首次登录奖励 / 额度管理 ── */}
          <div className="rounded-xl border dark:border-claude-darkBorder border-gray-200 overflow-hidden">
            <div className="px-4 py-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {claimed ? t('onboardingCreditsTitle') : t('onboardingClaimTitle')}
                </span>
                {claimed && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    已领取
                  </span>
                )}
              </div>

              {!claimed ? (
                <>
                  <p className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted mb-3">
                    {t('onboardingClaimDesc')}
                  </p>
                  <button
                    onClick={handleClaim}
                    disabled={claiming}
                    className="w-full py-2.5 rounded-lg bg-claude-accent hover:bg-claude-accentHover disabled:opacity-60 text-white text-sm font-medium transition-colors"
                  >
                    {claiming ? t('onboardingClaiming') : t('onboardingClaimBtn')}
                  </button>
                </>
              ) : (
                <div className="flex items-center justify-between mt-2">
                  <div>
                    <div className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted">剩余额度</div>
                    <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                      {(cloudService.getCachedCredits() / 10000).toFixed(0)}万 tokens
                    </div>
                    <div className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted">
                      约可对话 {cloudService.estimateChats()} 次
                    </div>
                  </div>
                  <button
                    onClick={onComplete}
                    className="px-4 py-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white text-sm font-medium transition-colors"
                  >
                    开始使用
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── 自带 API Key（折叠） ── */}
          <div className="rounded-xl border dark:border-claude-darkBorder border-gray-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setKeyExpanded(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:dark:bg-claude-darkBg hover:bg-gray-50 transition-colors"
            >
              <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                {t('onboardingOwnKey')}
              </span>
              {keyExpanded
                ? <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextMuted text-claude-textMuted" />
                : <ChevronRightIcon className="h-4 w-4 dark:text-claude-darkTextMuted text-claude-textMuted" />
              }
            </button>

            {keyExpanded && (
              <div className="px-4 pb-4 pt-1 border-t dark:border-claude-darkBorder border-gray-100 space-y-2">
                {!selectedProvider ? (
                  /* Provider list */
                  <div className="space-y-1.5">
                    {PROVIDERS.map((p) => (
                      <button
                        key={p.key}
                        onClick={() => { setSelectedProvider(p); setApiKey(''); setKeyError(''); }}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border dark:border-claude-darkBorder border-gray-200 dark:bg-claude-darkBg bg-gray-50 hover:border-claude-accent dark:hover:border-claude-accent transition-all text-left group"
                      >
                        <span className="text-sm dark:text-claude-darkText text-claude-text">{p.label}</span>
                        <ChevronRightIcon className="h-3.5 w-3.5 dark:text-claude-darkTextMuted text-claude-textMuted group-hover:text-claude-accent transition-colors" />
                      </button>
                    ))}
                  </div>
                ) : (
                  /* Key input */
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setSelectedProvider(null)}
                        className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted hover:text-claude-accent transition-colors"
                      >
                        ← {t('onboardingBack')}
                      </button>
                      <span className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted">
                        {selectedProvider.label}
                      </span>
                    </div>
                    <div className="relative">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => { setApiKey(e.target.value); setKeyError(''); }}
                        placeholder={t('setupWizardApiKeyPlaceholder')}
                        autoFocus
                        className="w-full pr-9 pl-3 py-2.5 rounded-lg border dark:border-claude-darkBorder border-gray-200 dark:bg-claude-darkBg bg-gray-50 dark:text-claude-darkText text-claude-text text-sm outline-none focus:border-claude-accent transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(v => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 dark:text-claude-darkTextMuted text-claude-textMuted hover:text-claude-accent transition-colors"
                        tabIndex={-1}
                      >
                        {showKey ? <EyeSlashIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                      </button>
                    </div>
                    {keyError && <p className="text-xs text-red-500 pl-0.5">{keyError}</p>}
                    <button
                      onClick={() => handleOpenUrl(selectedProvider.getKeyUrl)}
                      className="text-xs text-claude-accent hover:underline"
                    >
                      {t('setupWizardApiKeyGetKey')}
                    </button>
                    <button
                      onClick={handleSaveKey}
                      disabled={saving}
                      className="w-full py-2.5 rounded-lg bg-claude-accent hover:bg-claude-accentHover disabled:opacity-60 text-white text-sm font-medium transition-colors"
                    >
                      {saving ? t('onboardingSaving') : t('onboardingFinish')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 稍后再说 */}
          <div className="text-center pt-1">
            <button
              onClick={onComplete}
              className="text-xs dark:text-claude-darkTextMuted text-claude-textMuted hover:underline"
            >
              {t('onboardingSkip')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SetupWizard;
