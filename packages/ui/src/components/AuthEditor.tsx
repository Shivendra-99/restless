import { useState, type ReactNode } from 'react';
import {
  AUTH_LABELS,
  interpolate,
  newAuth,
  oauth2Authorize,
  oauth2TokenRequest,
  readOAuth2Redirect,
  readOAuth2Token,
  type Auth,
  type Bridge,
  type JwtAlgorithm,
  type OAuth2Grant,
  type RequestItem,
  type VariableInfo,
} from '@restless/core';
import { errorText } from '../util';

type AuthOf<T extends Auth['type']> = Extract<Auth, { type: T }>;

// The order of the menu: simplest first, then the signed kinds.
const ORDER: Auth['type'][] = ['none', 'apikey', 'bearer', 'jwt', 'basic', 'digest', 'oauth1', 'oauth2', 'hawk', 'aws'];

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  hint?: ReactNode;
}

function Field({ label, value, onChange, placeholder, secret, hint }: FieldProps) {
  // A {{variable}} is not a secret, so it stays readable.
  const hide = secret && !value.includes('{{');
  return (
    <label className="field">
      {label}
      <input className="input mono" type={hide ? 'password' : 'text'} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange, hint }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; hint?: ReactNode }) {
  return (
    <label className="field">
      {label}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

interface Props {
  item: RequestItem;
  set: (p: Partial<RequestItem>) => void;
  bridge: Bridge;
  vars: Map<string, VariableInfo>;
  /** Create or update a global variable (new ones are kept on this computer only). */
  saveGlobal: (name: string, value: string) => void;
}

export function AuthEditor({ item, set, bridge, vars, saveGlobal }: Props) {
  const a = item.auth;
  const patch = (p: Record<string, unknown>) => set({ auth: { ...a, ...p } as Auth });
  return (
    <div className="auth-grid">
      <label className="field">
        Type
        <select className="select" aria-label="Auth type" value={a.type} onChange={(e) => set({ auth: newAuth(e.target.value as Auth['type']) })}>
          {ORDER.map((t) => (
            <option key={t} value={t}>
              {AUTH_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      {a.type === 'bearer' && (
        <Field label="Token" value={a.token} placeholder="{{token}}" onChange={(token) => patch({ token })} hint={<>Tip: send your login request, click the token in its response and save it as a variable. Then use it here as {'{{access_token}}'}.</>} />
      )}

      {a.type === 'basic' && (
        <>
          <Field label="Username" value={a.username} onChange={(username) => patch({ username })} />
          <Field label="Password" value={a.password} secret onChange={(password) => patch({ password })} />
        </>
      )}

      {a.type === 'apikey' && (
        <>
          <Field label="Key" value={a.key} onChange={(key) => patch({ key })} />
          <Field label="Value" value={a.value} placeholder="{{apiKey}}" onChange={(value) => patch({ value })} />
          <Choice label="Send in" value={a.in} options={[['header', 'Header'], ['query', 'Query param']]} onChange={(v) => patch({ in: v })} />
        </>
      )}

      {a.type === 'jwt' && <JwtFields a={a} patch={patch} />}

      {a.type === 'digest' && (
        <>
          <Field label="Username" value={a.username} onChange={(username) => patch({ username })} />
          <Field label="Password" value={a.password} secret onChange={(password) => patch({ password })} />
          <p className="hint-line">The request goes out twice: the server answers the first with a 401 challenge, and Restless answers that. MD5 and SHA-256 are supported.</p>
        </>
      )}

      {a.type === 'oauth1' && (
        <>
          <Field label="Consumer key" value={a.consumerKey} onChange={(consumerKey) => patch({ consumerKey })} />
          <Field label="Consumer secret" value={a.consumerSecret} secret onChange={(consumerSecret) => patch({ consumerSecret })} />
          <Field label="Access token" value={a.token} onChange={(token) => patch({ token })} hint="Leave both token fields empty for a two-legged request." />
          <Field label="Token secret" value={a.tokenSecret} secret onChange={(tokenSecret) => patch({ tokenSecret })} />
          <Choice label="Signature method" value={a.signatureMethod} options={[['HMAC-SHA1', 'HMAC-SHA1'], ['HMAC-SHA256', 'HMAC-SHA256'], ['PLAINTEXT', 'PLAINTEXT']]} onChange={(v) => patch({ signatureMethod: v })} />
          <Field label="Realm (optional)" value={a.realm} onChange={(realm) => patch({ realm })} />
        </>
      )}

      {a.type === 'oauth2' && <OAuth2Fields a={a} patch={patch} bridge={bridge} vars={vars} saveGlobal={saveGlobal} />}

      {a.type === 'hawk' && (
        <>
          <Field label="Hawk auth ID" value={a.id} onChange={(id) => patch({ id })} />
          <Field label="Hawk auth key" value={a.key} secret onChange={(key) => patch({ key })} />
          <Choice label="Algorithm" value={a.algorithm} options={[['sha256', 'SHA-256'], ['sha1', 'SHA-1']]} onChange={(v) => patch({ algorithm: v })} />
          <Field label="Extra data (optional)" value={a.ext} onChange={(ext) => patch({ ext })} hint="Sent as ext and included in the signature." />
        </>
      )}

      {a.type === 'aws' && (
        <>
          <Field label="Access key" value={a.accessKey} placeholder="AKIA…" onChange={(accessKey) => patch({ accessKey })} />
          <Field label="Secret key" value={a.secretKey} secret onChange={(secretKey) => patch({ secretKey })} />
          <Field label="Region" value={a.region} placeholder="us-east-1" onChange={(region) => patch({ region })} />
          <Field label="Service" value={a.service} placeholder="s3, execute-api, dynamodb…" onChange={(service) => patch({ service })} hint="The short name AWS signs with. For API Gateway it is execute-api." />
          <Field label="Session token (optional)" value={a.sessionToken} secret onChange={(sessionToken) => patch({ sessionToken })} hint="Only for temporary credentials (STS, SSO, an assumed role)." />
        </>
      )}

      {a.type !== 'none' && a.type !== 'bearer' && <p className="hint-line">Every field takes {'{{variables}}'}. Keeping secrets in variables marked “only on this computer” keeps them out of the workspace files.</p>}
    </div>
  );
}

const JWT_ALGS: [JwtAlgorithm, string][] = [
  ['HS256', 'HS256 (shared secret)'], ['HS384', 'HS384 (shared secret)'], ['HS512', 'HS512 (shared secret)'],
  ['RS256', 'RS256 (RSA private key)'], ['RS384', 'RS384 (RSA private key)'], ['RS512', 'RS512 (RSA private key)'],
  ['ES256', 'ES256 (EC P-256 private key)'], ['ES384', 'ES384 (EC P-384 private key)'],
];

function JwtFields({ a, patch }: { a: AuthOf<'jwt'>; patch: (p: Record<string, unknown>) => void }) {
  const hs = a.algorithm.startsWith('HS');
  let payloadError = '';
  if (!a.payload.includes('{{')) {
    try {
      JSON.parse(a.payload || '{}');
    } catch (e) {
      payloadError = errorText(e);
    }
  }
  return (
    <>
      <Choice label="Algorithm" value={a.algorithm} options={JWT_ALGS} onChange={(v) => patch({ algorithm: v })} />
      {hs ? (
        <>
          <Field label="Secret" value={a.secret} secret onChange={(secret) => patch({ secret })} />
          <label className="check">
            <input type="checkbox" checked={a.secretBase64} onChange={(e) => patch({ secretBase64: e.target.checked })} />
            The secret is base64 encoded
          </label>
        </>
      ) : (
        <label className="field">
          Private key (PEM)
          <textarea className="textarea" rows={5} spellCheck={false} value={a.secret} placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'} onChange={(e) => patch({ secret: e.target.value })} />
          <span className="hint">The key signs on this computer and is never sent. A {'{{variable}}'} holding the PEM text works too.</span>
        </label>
      )}
      <label className="field">
        Payload (JSON)
        <textarea className="textarea" rows={6} spellCheck={false} aria-label="JWT payload" value={a.payload} onChange={(e) => patch({ payload: e.target.value })} />
        <span className="hint">
          A new token is signed on every send. {'{{$timestamp}}'} is the current time in seconds, so <code>"iat": {'{{$timestamp}}'}</code> is always fresh.
        </span>
      </label>
      {payloadError && <div className="notice warn" style={{ margin: 0 }}>The payload is not valid JSON yet: {payloadError}</div>}
      <Field label="Header prefix" value={a.prefix} placeholder="Bearer" onChange={(prefix) => patch({ prefix })} hint="Sent as: Authorization: <prefix> <token>" />
    </>
  );
}

const GRANTS: [OAuth2Grant, string][] = [
  ['client_credentials', 'Client credentials'],
  ['password', 'Password'],
  ['authorization_code', 'Authorization code (with PKCE)'],
];

function OAuth2Fields({ a, patch, bridge, vars, saveGlobal }: { a: AuthOf<'oauth2'>; patch: (p: Record<string, unknown>) => void; bridge: Bridge; vars: Map<string, VariableInfo>; saveGlobal: (name: string, value: string) => void }) {
  // When the token field names one variable, new tokens go into that variable instead of into the request file.
  const tokenVar = a.token.trim().match(/^\{\{\s*([^{}\s]+)\s*\}\}$/)?.[1];
  const current = tokenVar ? vars.get(tokenVar)?.value ?? '' : a.token;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const needsWindow = a.grant === 'authorization_code';
  const canGet = !needsWindow || !!bridge.authorize;

  const getToken = async () => {
    setStatus(null);
    setBusy(true);
    try {
      const map = Object.fromEntries([...vars].map(([k, v]) => [k, v.value]));
      const filled = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'string' && k !== 'type' ? interpolate(v, map) : v])) as AuthOf<'oauth2'>;
      let request;
      if (filled.grant === 'authorization_code') {
        const start = await oauth2Authorize(filled);
        const back = await bridge.authorize!(start.url, filled.redirectUri);
        request = oauth2TokenRequest(filled, { code: readOAuth2Redirect(back, start.state), verifier: start.verifier });
      } else request = oauth2TokenRequest(filled);
      const token = readOAuth2Token(await bridge.sendHttp(request));
      if (tokenVar) {
        saveGlobal(tokenVar, token.token);
        patch({ expiresAt: token.expiresAt, prefix: token.prefix ?? a.prefix });
      } else patch({ token: token.token, expiresAt: token.expiresAt, prefix: token.prefix ?? a.prefix });
      const until = token.expiresAt ? ` It works until ${new Date(token.expiresAt).toLocaleTimeString()}.` : '';
      setStatus({ tone: 'ok', text: tokenVar ? `Got a token and saved it in {{${tokenVar}}}.${until}` : `Got a token.${until}` });
    } catch (e) {
      setStatus({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const expired = !!a.expiresAt && !!current && a.expiresAt < Date.now();
  return (
    <>
      <Choice label="Grant type" value={a.grant} options={GRANTS} onChange={(grant) => patch({ grant })} />
      {needsWindow && <Field label="Authorization URL" value={a.authUrl} placeholder="https://example.com/oauth/authorize" onChange={(authUrl) => patch({ authUrl })} />}
      <Field label="Token URL" value={a.tokenUrl} placeholder="https://example.com/oauth/token" onChange={(tokenUrl) => patch({ tokenUrl })} />
      <Field label="Client ID" value={a.clientId} onChange={(clientId) => patch({ clientId })} />
      <Field label={needsWindow ? 'Client secret (optional with PKCE)' : 'Client secret'} value={a.clientSecret} secret onChange={(clientSecret) => patch({ clientSecret })} />
      {a.grant === 'password' && (
        <>
          <Field label="Username" value={a.username} onChange={(username) => patch({ username })} />
          <Field label="Password" value={a.password} secret onChange={(password) => patch({ password })} />
        </>
      )}
      {needsWindow && <Field label="Redirect URI" value={a.redirectUri} onChange={(redirectUri) => patch({ redirectUri })} hint="Must be one of the redirect URIs registered for this client. Nothing has to listen there: Restless reads the code as the sign-in page redirects." />}
      <Field label="Scope (optional)" value={a.scope} placeholder="read write" onChange={(scope) => patch({ scope })} />
      <Choice label="Send client ID and secret" value={a.clientAuth} options={[['basic', 'As a Basic auth header'], ['body', 'In the request body']]} onChange={(clientAuth) => patch({ clientAuth })} />

      <div className="token-row">
        <button className="btn primary" disabled={busy || !canGet} onClick={() => void getToken()}>
          {busy ? (needsWindow ? 'Waiting for sign-in…' : 'Asking…') : 'Get new access token'}
        </button>
        {status && (
          <span className={`token-status ${status.tone}`} role="status">
            {status.text}
          </span>
        )}
      </div>
      {!canGet && <div className="notice warn" style={{ margin: 0 }}>Signing in through a browser window needs the Restless desktop app. Here, get a token another way and paste it below.</div>}

      <Field label="Access token" value={a.token} placeholder="Filled in by the button above, or paste one" onChange={(token) => patch({ token, expiresAt: undefined })}
        hint={
          tokenVar
            ? `${current ? 'There is a token' : 'No token yet'} in {{${tokenVar}}}. New tokens are saved there, on this computer only, so they stay out of the workspace files.`
            : 'A token typed here is saved with the request. Write a variable such as {{oauth_token}} to keep it out of the workspace files.'
        }
      />
      {expired && <div className="notice warn" style={{ margin: 0 }}>This token ran out at {new Date(a.expiresAt!).toLocaleTimeString()}. Get a new one.</div>}
      <Field label="Header prefix" value={a.prefix} placeholder="Bearer" onChange={(prefix) => patch({ prefix })} />
    </>
  );
}
