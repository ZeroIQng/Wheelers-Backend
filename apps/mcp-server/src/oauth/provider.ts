import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { GatewayClient, GatewayError } from '../gateway/client';
import { OAuthStore, readJwtExpiry } from './store';

export const WHEELERS_SCOPE = 'wheelers:user';

export interface WheelersOAuthProviderConfig {
  store: OAuthStore;
  gateway: GatewayClient;
  accessTokenTtlSeconds: number;
  allowGatewayTokens: boolean;
}

/**
 * Self-contained OAuth 2.1 authorization server. Claude (web, desktop, Code)
 * registers itself dynamically, sends the user to our login page, and gets
 * back opaque tokens that map to the user's own api-gateway session. Tools
 * then call the gateway with that session — the MCP server holds no secrets
 * of its own and cannot act for anyone who has not signed in.
 */
export class WheelersOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(private readonly config: WheelersOAuthProviderConfig) {
    const store = config.store;
    this.clientsStore = {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        await store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const sid = await this.config.store.createLoginSession({
      clientId: client.client_id,
      clientName: client.client_name ?? null,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [WHEELERS_SCOPE],
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.toString(),
      createdAt: new Date().toISOString(),
    });

    res.redirect(`/oauth/login?sid=${encodeURIComponent(sid)}`);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await this.config.store.getAuthorizationCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid or has expired.');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.config.store.consumeAuthorizationCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid or has expired.');
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }

    const issued = await this.config.store.issueTokens({
      clientId: client.client_id,
      scopes: record.scopes,
      userId: record.userId,
      gatewayToken: record.gatewayToken,
      gatewayTokenExp: record.gatewayTokenExp,
      accessTtlSeconds: this.config.accessTokenTtlSeconds,
    });

    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: record.scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.config.store.consumeRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token is invalid or has expired. Sign in again.');
    }

    const now = Math.floor(Date.now() / 1000);
    if (record.gatewayTokenExp <= now + 60) {
      throw new InvalidGrantError('Your Wheelers session has expired. Sign in again.');
    }

    const grantedScopes = scopes?.length ? scopes.filter((s) => record.scopes.includes(s)) : record.scopes;

    const issued = await this.config.store.issueTokens({
      clientId: client.client_id,
      scopes: grantedScopes,
      userId: record.userId,
      gatewayToken: record.gatewayToken,
      gatewayTokenExp: record.gatewayTokenExp,
      accessTtlSeconds: this.config.accessTokenTtlSeconds,
    });

    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: grantedScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.config.store.getAccessToken(token);
    if (record) {
      return {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
        extra: { userId: record.userId, gatewayToken: record.gatewayToken },
      };
    }

    // Fallback: a raw api-gateway JWT presented directly (Claude Code
    // `--header "Authorization: Bearer <token>"`). Verified by asking the
    // gateway who it belongs to; cached briefly to avoid a round-trip per call.
    if (this.config.allowGatewayTokens && token.split('.').length === 3) {
      const exp = readJwtExpiry(token);
      if (exp && exp > Math.floor(Date.now() / 1000)) {
        let userId = await this.config.store.getCachedGatewayUser(token);
        if (!userId) {
          try {
            const me = await this.config.gateway.withToken(token).me();
            userId = me.user.id;
            await this.config.store.cacheGatewayUser(token, userId, 300);
          } catch (error) {
            if (error instanceof GatewayError && error.status === 401) {
              throw new InvalidTokenError('Wheelers access token was rejected by the API.');
            }
            throw error;
          }
        }
        return {
          token,
          clientId: 'gateway-token',
          scopes: [WHEELERS_SCOPE],
          expiresAt: exp,
          extra: { userId, gatewayToken: token },
        };
      }
    }

    throw new InvalidTokenError('Access token is invalid or has expired.');
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.config.store.revoke(request.token);
  }
}
