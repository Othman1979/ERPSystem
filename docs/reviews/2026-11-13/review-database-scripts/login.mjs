import fs from 'node:fs';
import { BASE, loadCreds, saveCreds } from './lib.mjs';
const c = loadCreds();
const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.email, password: c.password }) });
const body = await res.json();
const rt = (res.headers.getSetCookie?.() ?? []).map((x) => /^refresh_token=([^;]+)/.exec(x)?.[1]).find(Boolean);
console.log('login', res.status, Object.keys(body));
saveCreds({ ...c, accessToken: body.accessToken, refreshToken: rt ?? c.refreshToken });
