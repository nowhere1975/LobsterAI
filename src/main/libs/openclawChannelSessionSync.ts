/**
 * OpenClaw Channel Session Sync
 *
 * Discovers and maps sessions created by OpenClaw channel extensions (e.g. Telegram)
 * to local Cowork sessions so that conversations are visible in the LobsterAI UI.
 */

import type { CoworkStore } from '../coworkStore';
import type { IMStore } from '../im/imStore';
import type { IMPlatform } from '../im/types';

const LOBSTERAI_SESSION_PREFIX = 'lobsterai:';

/** Known OpenClaw channel prefixes mapped to IM platforms. */
const CHANNEL_PLATFORM_MAP: Record<string, IMPlatform> = {
  telegram: 'telegram',
  discord: 'discord',
  feishu: 'feishu',
  'dingtalk-connector': 'dingtalk',
  qqbot: 'qq',
};

/** Parse a channel sessionKey into platform + conversationId.
 *  Supports two formats:
 *  - OpenClaw format: "agent:{agentId}:{platform}:{subtype}:{conversationId}"
 *  - Legacy format:   "{platform}:{conversationId}"
 */
function parseChannelSessionKey(sessionKey: string): { platform: IMPlatform; conversationId: string } | null {
  if (!sessionKey || sessionKey.startsWith(LOBSTERAI_SESSION_PREFIX)) return null;

  // Handle OpenClaw format: agent:{agentId}:{platform}:{subtype}:{conversationId}
  // For HTTP-originating sessions (e.g. DingTalk plugin), the format is:
  //   agent:{agentId}:openai-user:{channel}:{conversationId}
  // where parts[2] is "openai-user" and the actual channel name is in parts[3].
  if (sessionKey.startsWith('agent:')) {
    const parts = sessionKey.split(':');
    // Need at least: agent, agentId, platform, and one more segment
    if (parts.length >= 4) {
      let platform = CHANNEL_PLATFORM_MAP[parts[2]];
      if (platform) {
        const conversationId = parts.slice(3).join(':');
        if (conversationId) return { platform, conversationId };
      }
      // Fallback: parts[2] may be a session subtype (e.g. "openai-user");
      // check parts[3] for the actual channel name.
      if (!platform && parts.length >= 5) {
        platform = CHANNEL_PLATFORM_MAP[parts[3]];
        if (platform) {
          const conversationId = parts.slice(4).join(':');
          if (conversationId) return { platform, conversationId };
        }
      }
    }
    return null;
  }

  // Legacy format: {platform}:{conversationId}
  const colonIndex = sessionKey.indexOf(':');
  if (colonIndex <= 0) return null;

  const channelName = sessionKey.slice(0, colonIndex);
  const platform = CHANNEL_PLATFORM_MAP[channelName];
  if (!platform) return null;

  const conversationId = sessionKey.slice(colonIndex + 1);
  if (!conversationId) return null;

  return { platform, conversationId };
}

/** Match OpenClaw main agent session keys like "agent:main:main" or "agent:secondary:main". */
const MAIN_AGENT_SESSION_RE = /^agent:[^:]+:main$/;

/** Map from channel prefix to title label. */
const CHANNEL_TITLE_PREFIX: Record<string, string> = {
  telegram: '[TG]',
  discord: '[Discord]',
  feishu: '[飞书]',
  'dingtalk-connector': '[钉钉]',
  qqbot: '[QQ]',
};

export interface ChannelSessionSyncDeps {
  coworkStore: CoworkStore;
  imStore: IMStore;
  getDefaultCwd: () => string;
}

export class OpenClawChannelSessionSync {
  private readonly coworkStore: CoworkStore;
  private readonly imStore: IMStore;
  private readonly getDefaultCwd: () => string;

  /** In-memory cache: openclawSessionKey → local sessionId. */
  private readonly syncedSessionKeys = new Map<string, string>();

  /** Keys that have been tried and are not recognized — avoids repeated log noise. */
  private readonly rejectedKeys = new Set<string>();

  constructor(deps: ChannelSessionSyncDeps) {
    this.coworkStore = deps.coworkStore;
    this.imStore = deps.imStore;
    this.getDefaultCwd = deps.getDefaultCwd;
  }

  /**
   * Try to resolve or create a local Cowork session for a channel-originated sessionKey.
   * Returns the local sessionId if the sessionKey belongs to a channel, or null if not.
   */
  resolveOrCreateSession(sessionKey: string): string | null {
    console.log('[ChannelSessionSync] resolveOrCreateSession called with key:', sessionKey);

    // 1. Skip LobsterAI-originated sessions
    if (sessionKey.startsWith(LOBSTERAI_SESSION_PREFIX)) {
      console.log('[ChannelSessionSync] skipped: LobsterAI-originated session');
      return null;
    }

    // 2. Check in-memory cache
    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) {
      return cached;
    }

    // 2b. Skip keys already known to be non-channel
    if (this.rejectedKeys.has(sessionKey)) {
      return null;
    }

    // 3. Parse channel info
    const parsed = parseChannelSessionKey(sessionKey);
    if (!parsed) {
      console.log('[ChannelSessionSync] parse failed: not a recognized channel key:', sessionKey);
      this.rejectedKeys.add(sessionKey);
      return null;
    }
    console.log('[ChannelSessionSync] parsed: platform=', parsed.platform, 'conversationId=', parsed.conversationId);

    // 4. Check persistent mapping in im_session_mappings
    const existingMapping = this.imStore.getSessionMapping(parsed.conversationId, parsed.platform);
    console.log('[ChannelSessionSync] existing mapping:', existingMapping ? `coworkSessionId=${existingMapping.coworkSessionId}` : 'none');
    if (existingMapping) {
      // Verify the Cowork session still exists
      const session = this.coworkStore.getSession(existingMapping.coworkSessionId);
      if (session) {
        console.log('[ChannelSessionSync] existing cowork session found, reusing:', existingMapping.coworkSessionId);
        this.syncedSessionKeys.set(sessionKey, existingMapping.coworkSessionId);
        this.imStore.updateSessionLastActive(parsed.conversationId, parsed.platform);
        return existingMapping.coworkSessionId;
      }
      // Session was deleted, remove stale mapping
      console.log('[ChannelSessionSync] cowork session deleted, removing stale mapping');
      this.imStore.deleteSessionMapping(parsed.conversationId, parsed.platform);
    }

    // 5. Create new Cowork session
    const titlePrefix = CHANNEL_TITLE_PREFIX[parsed.platform] || `[${parsed.platform}]`;
    const shortId = parsed.conversationId.length > 12
      ? parsed.conversationId.slice(-12)
      : parsed.conversationId;
    const title = `${titlePrefix} ${shortId}`;
    const cwd = this.getDefaultCwd();
    console.log('[ChannelSessionSync] creating new cowork session: title=', title, 'cwd=', cwd);

    const session = this.coworkStore.createSession(title, cwd, '', 'local');
    console.log(
      `[ChannelSessionSync] Created session for ${parsed.platform} conversation ${parsed.conversationId}: ${session.id}`,
    );

    // 6. Persist mapping
    this.imStore.createSessionMapping(parsed.conversationId, parsed.platform, session.id);
    console.log('[ChannelSessionSync] persisted mapping: conversationId=', parsed.conversationId, '→ sessionId=', session.id);

    // 7. Cache
    this.syncedSessionKeys.set(sessionKey, session.id);

    return session.id;
  }

  /**
   * Try to resolve (but NOT create) a local Cowork session for a channel sessionKey.
   * Used by polling to avoid creating empty sessions when no new messages have arrived.
   * Returns the local sessionId if found, or null if not mapped.
   */
  resolveSession(sessionKey: string): string | null {
    if (sessionKey.startsWith(LOBSTERAI_SESSION_PREFIX)) return null;

    // Check in-memory cache
    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) return cached;

    if (this.rejectedKeys.has(sessionKey)) return null;

    // Parse channel info
    const parsed = parseChannelSessionKey(sessionKey);
    if (!parsed) {
      this.rejectedKeys.add(sessionKey);
      return null;
    }

    // Check persistent mapping
    const existingMapping = this.imStore.getSessionMapping(parsed.conversationId, parsed.platform);
    if (existingMapping) {
      const session = this.coworkStore.getSession(existingMapping.coworkSessionId);
      if (session) {
        this.syncedSessionKeys.set(sessionKey, existingMapping.coworkSessionId);
        return existingMapping.coworkSessionId;
      }
      // Stale mapping, clean up
      this.imStore.deleteSessionMapping(parsed.conversationId, parsed.platform);
    }

    return null;
  }

  /** Check whether a sessionKey belongs to a recognized channel or main agent session. */
  isChannelSessionKey(sessionKey: string): boolean {
    if (!sessionKey || sessionKey.startsWith(LOBSTERAI_SESSION_PREFIX)) return false;
    if (parseChannelSessionKey(sessionKey) !== null) return true;
    if (MAIN_AGENT_SESSION_RE.test(sessionKey)) return true;
    return false;
  }

  /**
   * Resolve or create a local Cowork session for the OpenClaw main agent session
   * (e.g. "agent:main:main"). This handles events that flow through the main session
   * rather than per-channel sessions.
   */
  resolveOrCreateMainAgentSession(sessionKey: string): string | null {
    if (!MAIN_AGENT_SESSION_RE.test(sessionKey)) return null;

    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) {
      return cached;
    }

    const cwd = this.getDefaultCwd();
    console.log('[ChannelSessionSync] creating main agent session: key=', sessionKey, 'cwd=', cwd);
    const session = this.coworkStore.createSession('[OpenClaw]', cwd, '', 'local');
    console.log('[ChannelSessionSync] created main agent session:', session.id);

    this.syncedSessionKeys.set(sessionKey, session.id);
    return session.id;
  }

  /** Clear in-memory cache (e.g. on gateway reconnect). */
  clearCache(): void {
    this.syncedSessionKeys.clear();
    this.rejectedKeys.clear();
  }

  /**
   * Purge in-memory cache entries for a deleted session so that
   * new messages with the same sessionKey can create a fresh session.
   */
  onSessionDeleted(sessionId: string): void {
    for (const [key, id] of this.syncedSessionKeys.entries()) {
      if (id === sessionId) {
        this.syncedSessionKeys.delete(key);
        // Also remove from rejectedKeys in case it was previously rejected,
        // so that re-discovery can succeed.
        this.rejectedKeys.delete(key);
      }
    }
  }
}
