/* Carimbo: sincronização entre aparelhos.
   Tudo é criptografado no aparelho (AES-GCM, chave tirada da senha do cofre) antes de subir.
   No Supabase fica só um arquivo ilegível por documento. */
(() => {
const SB_URL = 'https://kesywpnrixnirhsmzdkv.supabase.co';
const SB_KEY = 'sb_publishable_76Qea6NcI1lUZZNJ4pWfvA_4DgjpToZ';   // chave pública: o acesso é protegido pelas regras do Supabase
const BUCKET = 'vault';
const KINDS = ['docs', 'trips'];

let sb = null, key = null, user = null, busy = false, again = false, timer = null;
const state = { status: 'off', last: null, error: '' };
const S = () => window.CarimboStore;
const listeners = new Set();
const emit = () => listeners.forEach(fn => { try { fn(state) } catch {} });
const set = (k, v) => { state[k] = v; emit() };

const loadScript = src => new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src));
  document.head.appendChild(s);
});
async function client(){
  if (sb) return sb;
  if (!window.supabase) await loadScript('vendor/supabase.js');
  sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'carimbo.auth' } });
  return sb;
}
const bucket = () => sb.storage.from(BUCKET);
const path = (...p) => [user.id, ...p].join('/');

/* ---------- Criptografia ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
async function deriveKey(pass, salt){
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return new Blob([out], { type: 'application/octet-stream' });
}
async function unseal(blob){
  const b = new Uint8Array(await blob.arrayBuffer());
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12))));
}

/* ---------- Documentos <-> JSON (arquivos viram texto) ---------- */
const toData = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b) });
const fromData = async d => d ? (await fetch(d)).blob() : null;
async function pack(kind, item){
  if (kind !== 'docs') return item;
  return { ...item, files: await Promise.all((item.files || []).map(async f => ({ name: f.name, type: f.type, data: await toData(f.blob), thumb: f.thumb ? await toData(f.thumb) : null }))) };
}
async function unpack(kind, item){
  if (kind !== 'docs') return item;
  return { ...item, files: await Promise.all((item.files || []).map(async f => ({ name: f.name, type: f.type, blob: await fromData(f.data), ...(f.thumb ? { thumb: await fromData(f.thumb) } : {}) }))) };
}

/* ---------- Conta ---------- */
// Uma senha só: daqui sai a senha da conta (embaralhada) e, separada, a chave do cofre.
// O Supabase recebe só a versão embaralhada; dela não dá para chegar na chave do cofre.
async function loginSecret(email, pass){
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('carimbo-login:' + email), iterations: 200000, hash: 'SHA-256' }, base, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const authError = e => {
  const m = e?.message || '';
  if (/already registered|already exists/i.test(m)) return 'Este e-mail já tem conta. Toque em Entrar.';
  if (/invalid login|invalid credentials/i.test(m)) return 'E-mail ou senha errados.';
  if (/not confirmed/i.test(m)) return 'Falta confirmar o e-mail: abra o link que chegou na sua caixa de entrada e tente de novo.';
  if (/rate|security purposes|seconds/i.test(m)) return 'Muitas tentativas seguidas. Espere alguns minutos.';
  if (/fetch|network/i.test(m)) return 'Sem conexão. Tente quando estiver com internet.';
  return m || 'Algo deu errado. Tente de novo.';
};
async function signUp(email, pass){
  await client(); email = email.trim().toLowerCase();
  const { data, error } = await sb.auth.signUp({ email, password: await loginSecret(email, pass), options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(authError(error));
  if (data.user?.identities?.length === 0) throw new Error(authError({ message: 'already registered' }));
  if (!data.session) return 'confirm';            // precisa confirmar o e-mail primeiro
  user = data.session.user; S().setFlag(true);
  await unlock(pass);
  return 'ok';
}
async function signIn(email, pass){
  await client(); email = email.trim().toLowerCase();
  const { data, error } = await sb.auth.signInWithPassword({ email, password: await loginSecret(email, pass) });
  if (error) throw new Error(authError(error));
  user = data.user; S().setFlag(true);
  await unlock(pass);
}
async function hasVault(){
  const { data } = await bucket().list(user.id, { limit: 10 });
  return !!data?.some(o => o.name === 'salt');
}
// Cria ou abre o cofre com a senha. Confere a senha com um arquivo de teste criptografado.
async function unlock(pass){
  const exists = await hasVault();
  let salt;
  if (!exists) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    const up = await bucket().upload(path('salt'), new Blob([salt]), { upsert: true, contentType: 'application/octet-stream' });
    if (up.error) throw up.error;
  } else {
    const { data, error } = await bucket().download(path('salt'));
    if (error) throw error;
    salt = new Uint8Array(await data.arrayBuffer());
  }
  key = await deriveKey(pass, salt);
  if (!exists) {
    const up = await bucket().upload(path('check.bin'), await seal({ ok: 'carimbo' }), { upsert: true });
    if (up.error) throw up.error;
  } else {
    const { data } = await bucket().download(path('check.bin'));
    try { await unseal(data) } catch { key = null; throw new Error('Senha errada.') }
  }
  await S().metaPut('syncKey', key);
  emit();
  await syncNow();
}
async function signOut(){
  try { await (await client()).auth.signOut() } catch {}
  user = null; key = null;
  await S().metaPut('syncKey', null); await S().metaPut('syncState', null); await S().metaPut('syncDeleted', null);
  S().setFlag(false); set('status', 'off');
}

/* ---------- Sincronizar ---------- */
async function syncNow(){
  if (!user || !key) return;
  if (busy) { again = true; return }
  if (!navigator.onLine) { set('status', 'offline'); return }
  busy = true; set('status', 'syncing'); set('error', '');
  let changed = false;
  try {
    const st = (await S().metaGet('syncState')) || { docs: {}, trips: {} };
    const dels = (await S().metaGet('syncDeleted')) || { docs: [], trips: [] };
    for (const kind of KINDS) {
      const listRemote = async () => {
        const { data, error } = await bucket().list(path(kind), { limit: 1000 });
        if (error) throw error;
        return new Map((data || []).filter(o => o.name.endsWith('.bin')).map(o => [o.name.slice(0, -4), o.updated_at || o.created_at]));
      };
      const remote = await listRemote(), known = st[kind] || (st[kind] = {});
      // apagados neste aparelho: apaga na nuvem
      for (const id of dels[kind] || []) {
        if (remote.has(id)) await bucket().remove([path(kind, id + '.bin')]);
        remote.delete(id); delete known[id];
      }
      dels[kind] = [];
      for (const item of await S().dbAll(kind)) {
        const k = known[item.id], lu = item.updatedAt || item.createdAt || 0;
        if (!remote.has(item.id)) {
          if (k) { await S().dbDel(kind, item.id); delete known[item.id]; changed = true; continue }   // apagado no outro aparelho
          await push(kind, item); continue;                                                          // novo aqui
        }
        if (!k || lu > (k.l || 0)) await push(kind, item);                                           // mudou aqui
        else if (remote.get(item.id) !== k.r) { await pull(kind, item.id); changed = true }          // mudou lá
        remote.delete(item.id);
      }
      for (const id of remote.keys()) { await pull(kind, id); changed = true }                       // novo no outro aparelho
      // guarda o estado para comparar na próxima vez
      const now = await listRemote();
      st[kind] = {};
      for (const item of await S().dbAll(kind)) if (now.has(item.id)) st[kind][item.id] = { r: now.get(item.id), l: item.updatedAt || item.createdAt || 0 };
    }
    await S().metaPut('syncState', st); await S().metaPut('syncDeleted', dels);
    state.last = new Date(); set('status', 'ok');
  } catch (e) {
    console.warn('sync', e);
    set('error', /fetch|network/i.test(e.message || '') ? 'Sem conexão com o servidor.' : (e.message || 'Erro ao sincronizar'));
    set('status', 'error');
  } finally {
    busy = false;
    if (changed) await S().reload();
    if (again) { again = false; syncNow() }
  }
}
async function push(kind, item){
  const up = await bucket().upload(path(kind, item.id + '.bin'), await seal(await pack(kind, item)), { upsert: true });
  if (up.error) throw up.error;
}
async function pull(kind, id){
  const { data, error } = await bucket().download(path(kind, id + '.bin'));
  if (error) throw error;
  await S().dbPut(kind, await unpack(kind, await unseal(data)));
}

// Chamado pelo app depois de salvar ou apagar
function changed(){ clearTimeout(timer); timer = setTimeout(syncNow, 2500) }
async function deleted(kind, id){
  if (!user) return;
  const d = (await S().metaGet('syncDeleted')) || { docs: [], trips: [] };
  if (!d[kind].includes(id)) d[kind].push(id);
  await S().metaPut('syncDeleted', d); changed();
}
async function restored(kind, id){
  const d = (await S().metaGet('syncDeleted')) || { docs: [], trips: [] };
  d[kind] = d[kind].filter(x => x !== id); await S().metaPut('syncDeleted', d); changed();
}

async function init(){
  if (!S().getFlag()) return;
  try {
    await client();
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    key = await S().metaGet('syncKey');
    emit();
    if (user && key) syncNow();
  } catch (e) { console.warn('sync init', e) }
}
addEventListener('online', () => syncNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (!state.last || Date.now() - state.last > 60000)) syncNow() });

window.Sync = {
  init, signUp, signIn, hasVault, unlock, signOut, syncNow, changed, deleted, restored,
  on: fn => listeners.add(fn),
  get state(){ return { ...state, email: user?.email || '', signedIn: !!user, unlocked: !!key } },
};
})();
