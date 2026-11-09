import type { IncomingMessage, ServerResponse } from 'node:http';
import { Problem, object, text, uuid } from './domain.js';
import type { Cloud } from './storage.js';

type Session = { access_token: string; refresh_token: string; expires_in: number; user: unknown };

export class Auth {
  constructor(private cloud?: Cloud, private allowed: string[] = [], private admins: string[] = [], private secure = false) {}

  private headers(access?: string) {
    return {
      apikey: this.cloud!.anon, 'Content-Type': 'application/json',
      ...(access ? { Authorization: 'Bearer ' + access } : {}),
    };
  }

  private cookie(name: string, value: string, age: number) {
    return `${name}=${encodeURIComponent(value)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secure ? '; Secure' : ''}`;
  }

  private getCookies(req: IncomingMessage) {
    return Object.fromEntries((req.headers.cookie ?? '').split(';').map(part => {
      const [key, ...value] = part.trim().split('=');
      try { return [key, decodeURIComponent(value.join('='))]; } catch { return [key, '']; }
    }));
  }

  private who(raw: unknown) {
    const user = object(raw);
    const email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
    if (!this.allowed.includes(email) || !user.email_confirmed_at) throw new Problem(403, '此帳號未獲授權。');
    return { key: 'u-' + uuid(user.id), email, admin: this.admins.includes(email) };
  }

  async login(raw: unknown, res: ServerResponse) {
    if (!this.cloud) throw new Problem(404, '本機模式不需要登入。');
    const body = object(raw);
    const email = text(body.email, 254).toLowerCase();
    if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256) {
      throw new Problem(400, '密碼格式不正確。');
    }
    if (!this.allowed.includes(email)) throw new Problem(401, '電子郵件或密碼不正確。');
    const password = body.password;
    const session = await this.token('password', { email, password });
    if (!session) throw new Problem(401, '電子郵件或密碼不正確。');
    const user = this.who(session.user);
    this.setCookies(session, res);
    return user;
  }

  private async token(grant: string, body: unknown): Promise<Session | null> {
    const response = await fetch(this.cloud!.url + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(6_000),
    });
    if (response.status === 429) throw new Problem(429, '登入請求過多，請稍後再試。');
    if (response.status >= 500) throw new Problem(503, '登入服務暫時無法使用。');
    return response.ok ? await response.json() : null;
  }

  private setCookies(session: Session, res: ServerResponse) {
    res.setHeader('Set-Cookie', [
      this.cookie('inori_access', session.access_token, session.expires_in),
      this.cookie('inori_refresh', session.refresh_token, 7 * 86_400),
    ]);
  }

  async user(req: IncomingMessage, res: ServerResponse) {
    if (!this.cloud) return { key: 'local', email: '', admin: true };
    const cookies = this.getCookies(req);
    if (cookies.inori_access) {
      const response = await fetch(this.cloud.url + '/auth/v1/user', {
        headers: this.headers(cookies.inori_access), signal: AbortSignal.timeout(6_000),
      });
      if (response.ok) return this.who(await response.json());
      if (response.status >= 500) throw new Problem(503, '登入服務暫時無法使用。');
    }
    if (cookies.inori_refresh) {
      const session = await this.token('refresh_token', { refresh_token: cookies.inori_refresh });
      if (session) {
        const user = this.who(session.user);
        this.setCookies(session, res);
        return user;
      }
    }
    throw new Problem(401, '請先登入。');
  }

  async logout(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Set-Cookie', [this.cookie('inori_access', '', 0), this.cookie('inori_refresh', '', 0)]);
    const cookies = this.getCookies(req);
    if (!this.cloud || (!cookies.inori_access && !cookies.inori_refresh)) return;
    try {
      const access = cookies.inori_access || (await this.token('refresh_token', { refresh_token: cookies.inori_refresh }))?.access_token;
      if (access) await fetch(this.cloud.url + '/auth/v1/logout?scope=local', {
        method: 'POST', headers: this.headers(access), signal: AbortSignal.timeout(6_000),
      });
    } catch { /* Clearing the browser session still takes effect. */ }
  }
}
