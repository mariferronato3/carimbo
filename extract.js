/* Carimbo: leitura automática de documentos.
   Tudo roda no aparelho (OCR com Tesseract, PDFs com pdf.js). Nada é enviado. */
(() => {
const V = 'vendor/';
const abs = p => new URL(p, location.href).href;
const loadScript = src => new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src));
  document.head.appendChild(s);
});

/* ---------- Motores (carregados só quando precisa) ---------- */
let ocrP = null, pdfP = null;
function ocr(){
  return ocrP ||= (async () => {
    if (!window.Tesseract) await loadScript(V + 'tesseract.min.js');
    return Tesseract.createWorker(['por', 'eng'], 1, {
      workerPath: abs(V + 'worker.min.js'), corePath: abs(V), langPath: abs(V + 'lang'),
      workerBlobURL: false, cacheMethod: 'none', gzip: true,
    });
  })().catch(e => { ocrP = null; throw e });
}
function pdfjs(){
  return pdfP ||= import(abs(V + 'pdf.min.mjs')).then(m => {
    m.GlobalWorkerOptions.workerSrc = abs(V + 'pdf.worker.min.mjs'); return m;
  }).catch(e => { pdfP = null; throw e });
}

/* ---------- Imagem ---------- */
async function toCanvas(src, { crop, rotate = 0, maxW = 2000 } = {}){
  const bmp = await createImageBitmap(src, { imageOrientation: 'from-image' });
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (crop) { sy = Math.round(sh * crop[0]); sh = Math.round(sh * (crop[1] - crop[0])) }
  const s = Math.min(maxW / Math.max(sw, sh), 2.5);
  const w = Math.round(sw * s), h = Math.round(sh * s), turn = rotate % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = turn ? h : w; c.height = turn ? w : h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.translate(c.width / 2, c.height / 2); g.rotate(rotate * Math.PI / 180);
  g.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  // tons de cinza com contraste esticado: ajuda muito o OCR em fotos de celular
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const y = d[i] * .299 + d[i+1] * .587 + d[i+2] * .114; d[i] = y; if (y < lo) lo = y; if (y > hi) hi = y }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) d[i] = d[i+1] = d[i+2] = (d[i] - lo) * k;
  g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(img, 0, 0);
  return c;
}

async function ocrText(src){
  const w = await ocr();
  await w.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
  const { data } = await w.recognize(await toCanvas(src));
  return data.text || '';
}

// Lê a página inteira uma vez e devolve também as linhas com posição
async function ocrPage(src, maxW = 2400){
  const w = await ocr();
  await w.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
  const c = await toCanvas(src, { maxW });
  const { data } = await w.recognize(c, {}, { text: true, blocks: true });
  const lines = (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
  return { c, text: data.text || '', lines };
}

// Acha a faixa MRZ na página lida e relê só esse pedaço, ampliado
async function mrzFromPage(pg){
  const cand = pg.lines.filter(l => {
    const t = (l.text || '').replace(/\s/g, '');
    return t.length >= 20 && (/<{2,}|«|K<|<K/.test(t) || /^[A-Z0-9<]{25,}$/.test(t));
  });
  if (!cand.length) return null;
  const x0 = Math.min(...cand.map(l => l.bbox.x0)), y0 = Math.min(...cand.map(l => l.bbox.y0));
  const x1 = Math.max(...cand.map(l => l.bbox.x1)), y1 = Math.max(...cand.map(l => l.bbox.y1));
  const pad = Math.max(12, (y1 - y0) * .35);
  const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
  const bw = Math.min(pg.c.width, x1 + pad) - bx, bh = Math.min(pg.c.height, y1 + pad) - by;
  const s = Math.min(3, 2200 / bw);
  const k = document.createElement('canvas'); k.width = Math.round(bw * s); k.height = Math.round(bh * s);
  k.getContext('2d').drawImage(pg.c, bx, by, bw, bh, 0, 0, k.width, k.height);
  const w = await ocr();
  await w.setParameters({ tessedit_char_whitelist: MRZ_CHARS, tessedit_pageseg_mode: '6' });
  const { data } = await w.recognize(k);
  return parseMRZ(data.text || '');
}

/* ---------- Faixa MRZ (passaporte, visto, RG novo) ---------- */
const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const D2 = { O:'0', Q:'0', D:'0', U:'0', I:'1', L:'1', Z:'2', S:'5', B:'8', G:'6', T:'7', A:'4', '<':'0' };
const A2 = { 0:'O', 1:'I', 2:'Z', 5:'S', 8:'B', 6:'G', 4:'A' };
const dig = s => s.replace(/[OQDUILZSBGTA<]/g, c => D2[c]);
const alp = s => s.replace(/[0125864]/g, c => A2[c]);
function ck(s){
  const w = [7, 3, 1]; let t = 0;
  for (let i = 0; i < s.length; i++) { const c = s[i]; t += (c === '<' ? 0 : /\d/.test(c) ? +c : c.charCodeAt(0) - 55) * w[i % 3] }
  return String(t % 10);
}
function yymmdd(s, future){
  if (!/^\d{6}$/.test(s)) return null;
  const yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const now = new Date().getFullYear() % 100;
  const y = future ? 2000 + yy : (yy > now ? 1900 + yy : 2000 + yy);
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
// Corrige confusões de OCR (O/0, I/1, S/5...) no número usando o dígito verificador
function fixNumber(raw, digit){
  const amb = { O:'0', '0':'O', I:'1', '1':'I', S:'5', '5':'S', B:'8', '8':'B', Z:'2', '2':'Z', G:'6', '6':'G' };
  const pos = [...raw].map((c, i) => amb[c] ? i : -1).filter(i => i >= 0).slice(0, 7);
  for (let m = 0; m < 1 << pos.length; m++) {
    const a = [...raw]; pos.forEach((p, j) => { if (m >> j & 1) a[p] = amb[a[p]] });
    const s = a.join(''); if (ck(s) === digit) return { v: s, ok: true };
  }
  return { v: raw, ok: false };
}
function names(raw){
  let s = raw.replace(/[<KCL]{4,}$/, '').replace(/<+$/, '');
  if (!s.includes('<<') && /KK/.test(s)) s = s.replace('KK', '<<');
  const [sur, giv = ''] = s.split('<<');
  return titleCase(`${giv.replace(/</g, ' ')} ${sur.replace(/</g, ' ')}`.trim());
}

function parseMRZ(text){
  const L = text.toUpperCase().split('\n').map(l => l.replace(/[«‹(\[{]/g, '<').replace(/[^A-Z0-9<]/g, '')).filter(l => l.length >= 24);
  // Linha 2 de passaporte/visto: número, nacionalidade, nascimento, sexo, validade
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    for (let o = 0; o + 28 <= l.length; o++) {
      const w = l.slice(o);
      const birth = yymmdd(dig(w.slice(13, 19))), exp = yymmdd(dig(w.slice(21, 27)), true);
      if (!birth || !exp || !/[MFX<]/.test(w[20])) continue;
      if (ck(dig(w.slice(21, 27))) !== dig(w[27])) continue;
      const num = fixNumber(w.slice(0, 9).replace(/<+$/, ''), dig(w[9]));
      const top = L[i - 1] || '';
      const kind = /^V/.test(top) ? 'V' : /^P/.test(top) ? 'P' : '';
      return {
        kind, number: num.v, numberOk: num.ok,
        nationality: alp(w.slice(10, 13)).replace(/</g, ''),
        country: top.length > 5 ? alp(top.slice(2, 5)).replace(/</g, '') : '',
        holder: top.length > 6 ? names(alp(top.slice(5))) : '',
        birth, expires: exp,
      };
    }
  }
  // RG/identidade (TD1): 3 linhas de 30
  for (let i = 1; i < L.length; i++) {
    const w = L[i];
    const birth = yymmdd(dig(w.slice(0, 6))), exp = yymmdd(dig(w.slice(8, 14)), true);
    if (!birth || !exp || ck(dig(w.slice(8, 14))) !== dig(w[14])) continue;
    const top = L[i - 1], bottom = L[i + 1] || '';
    return {
      kind: 'I', number: top.slice(5, 14).replace(/<+$/, ''), numberOk: ck(top.slice(5, 14)) === dig(top[14] || ''),
      country: alp(top.slice(2, 5)).replace(/</g, ''), nationality: alp(w.slice(15, 18)).replace(/</g, ''),
      holder: names(alp(bottom)), birth, expires: exp,
    };
  }
  return null;
}

async function readMRZ(src, status, tries){
  const w = await ocr();
  await w.setParameters({ tessedit_char_whitelist: MRZ_CHARS, tessedit_pageseg_mode: '6' });
  for (const t of tries) {
    if (t.rotate === 90) status?.('Procurando com a imagem girada…');
    const { data } = await w.recognize(await toCanvas(src, t));
    const m = parseMRZ(data.text || '');
    if (m) return m;
  }
  return null;
}

// A faixa MRZ não tem acentos e o OCR troca letras: confere cada nome com o texto impresso
function lev(a, b){
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}
function fixName(name, text){
  const plain = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = text.toUpperCase().match(/[A-ZÀ-Ý]{3,}/g) || [];
  return name.split(' ').map(n => {
    const N = plain(n.toUpperCase());
    const hit = words.find(w => plain(w) === N) || words.find(w => Math.abs(w.length - N.length) <= 1 && lev(plain(w), N) <= 1);
    return hit ? titleCase(hit) : n;
  }).join(' ');
}

/* ---------- Texto livre ---------- */
const SMALL = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'para']);
function titleCase(s){
  return s.toLowerCase().replace(/\s+/g, ' ').trim().split(' ')
    .map((w, i) => i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
const MONTH = { jan:1, fev:2, feb:2, mar:3, abr:4, apr:4, mai:5, may:5, jun:6, jul:7, ago:8, aug:8, set:9, sep:9, out:10, oct:10, nov:11, dez:12, dec:12, ene:1, dic:12 };
const iso = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2100) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
const fullYear = y => y < 100 ? 2000 + y : y;

function findDates(text){
  const out = [], push = (date, i) => { if (date) out.push({ date, i, ctx: text.slice(Math.max(0, i - 50), i).toLowerCase() }) };
  let m;
  const r1 = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})\b/g;
  while ((m = r1.exec(text))) push(iso(fullYear(+m[3]), +m[2], +m[1]), m.index);
  const r2 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = r2.exec(text))) push(iso(+m[1], +m[2], +m[3]), m.index);
  // inclui o formato bilíngue do passaporte: "11 FEV/FEB 2021"
  const r3 = /\b(\d{1,2})\s*(?:de\s+)?([A-Za-zçÇ]{3,9})(?:\/[A-Za-z]{3,9})?\.?\s*(?:de\s+)?,?\s*(\d{4})\b/g;
  while ((m = r3.exec(text))) { const mo = MONTH[m[2].slice(0, 3).toLowerCase()]; if (mo) push(iso(+m[3], mo, +m[1]), m.index) }
  const r4 = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
  while ((m = r4.exec(text))) { const mo = MONTH[m[1].slice(0, 3).toLowerCase()]; if (mo) push(iso(+m[3], mo, +m[2]), m.index) }
  // formato de companhia aérea: 12NOV, 12NOV26, 02Nov2026
  const r5 = /\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4}|\d{2})?\b/gi;
  while ((m = r5.exec(text))) {
    let y = m[3] ? (m[3].length === 4 ? +m[3] : 2000 + +m[3]) : new Date().getFullYear();
    let d = iso(y, MONTH[m[2].toLowerCase()], +m[1]);
    if (d && !m[3] && new Date(d) < new Date(Date.now() - 864e5 * 30)) d = iso(y + 1, MONTH[m[2].toLowerCase()], +m[1]);
    push(d, m.index);
  }
  // a mesma data pode casar em dois formatos: fica uma por posição
  return out.filter((d, k) => out.findIndex(e => e.i === d.i) === k).sort((a, b) => a.i - b.i);
}
const fmtBR = d => d.split('-').reverse().join('/');

// Bilhetes com vários voos: "São Paulo (GRU) to Dubai (DXB)" ... dados de cada trecho
function parseLegs(T){
  const re = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{1,30}?)\s*\(([A-Z]{3})\)\s*(?:to|para|-|–|→|>|a)\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'-]{1,30}?)\s*\(([A-Z]{3})\)/g;
  const hits = [...T.matchAll(re)].filter(m => AIRPORTS.has(m[2]) || AIRPORTS.has(m[4]));
  return hits.map((m, i) => {
    const seg = T.slice(m.index, hits[i + 1]?.index ?? m.index + 1500);
    const ds = findDates(seg);
    const at = re2 => {
      const d = ds.find(x => re2.test(x.ctx.slice(-30))); if (!d) return '';
      const t = (seg.slice(d.i, d.i + 30).match(/^\S+(?:\s\S+){0,2}?\s+(\d{1,2}[:h]\d{2})\b/) || [])[1] || (seg.slice(Math.max(0, d.i - 14), d.i).match(/(\d{1,2}[:h]\d{2})\s*$/) || [])[1];
      return t ? `${d.date}T${t.replace(/h/i, ':').padStart(5, '0')}` : d.date;
    };
    const clean = c => titleCase(c.replace(/^(?:leg\s+\d+\s+of\s+\d+\s*\|?\s*|de\s+|from\s+|\|\s*)/i, '').trim());
    return {
      from: clean(m[1]), fromCode: m[2], to: clean(m[3]), toCode: m[4],
      flight: ((seg.match(/\b(?:flight|voo|vuelo)\b[^\n]{0,10}\n?\s*([A-Z0-9]{2}\s?\d{2,4})\b/i) || [])[1] || '').toUpperCase(),
      dep: at(/(departure|partida|sa[íi]da|decolagem)[\s\S]*$/i),
      arr: at(/(arrival|chegada|llegada)[\s\S]*$/i),
      terminal: (seg.match(/terminal\s*[:\-]?\s*([A-Z0-9]{1,3})\b/i) || [])[1] || '',
      seat: (seg.match(/(?:seat|assento|poltrona)\s*[:\-]?\s*(\d{1,2}[A-K])\b/i) || [])[1] || '',
    };
  });
}
const near = (dates, re) => dates.find(d => re.test(d.ctx.slice(-35)))?.date;
const latest = dates => dates.map(d => d.date).sort().pop();
const future = dates => dates.filter(d => d.date >= new Date(Date.now() - 864e5 * 400).toISOString().slice(0, 10));
const grab = (text, re, ok = () => true) => { const m = text.match(re); return m && ok(m[1]) ? m[1].trim() : '' };
const oneOf = (text, list) => list.find(n => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) || '';
const upperCode = s => s === s.toUpperCase() && /[A-Z]/.test(s) && /\d/.test(s) || /^[A-Z]{6}$/.test(s);

const AIRLINES = ['LATAM', 'GOL', 'Azul', 'TAP Air Portugal', 'TAP', 'Air France', 'KLM', 'Iberia', 'American Airlines', 'United Airlines', 'Delta', 'Vietnam Airlines', 'VietJet', 'Thai Airways', 'Singapore Airlines', 'Cathay Pacific', 'Japan Airlines', 'ANA', 'Korean Air', 'Etihad', 'AirAsia', 'Qantas', 'EVA Air', 'China Airlines', 'Malaysia Airlines', 'Philippine Airlines', 'Jetstar', 'Scoot', 'Aeroméxico', 'Sky Airline', 'Arajet', 'Norwegian', 'SAS', 'Finnair', 'Aer Lingus', 'Virgin Atlantic', 'Southwest', 'JetBlue', 'Condor', 'Eurowings', 'Wizz Air', 'Transavia', 'Brussels Airlines', 'Austrian', 'LOT', 'Aegean', 'Pegasus', 'Saudia', 'Oman Air', 'EgyptAir', 'South African Airways', 'Emirates', 'Qatar Airways', 'Lufthansa', 'British Airways', 'Copa', 'Avianca', 'Aerolíneas Argentinas', 'Turkish Airlines', 'Air Europa', 'ITA Airways', 'Swiss', 'Ryanair', 'easyJet', 'Vueling', 'JetSMART', 'Air Canada', 'Ethiopian', 'Royal Air Maroc'];
const STAYS = ['Booking.com', 'Airbnb', 'Expedia', 'Hotels.com', 'Decolar', 'Agoda', 'Accor', 'Marriott', 'Hilton', 'IHG', 'Ibis', 'Novotel', 'Meliá', 'NH Hotels', 'Hostelworld', 'Vrbo'];
const INSURERS = ['Assist Card', 'Affinity', 'GTA', 'Travel Ace', 'Allianz', 'Porto Seguro', 'Intermac', 'Vital Card', 'April', 'Universal Assistance', 'Coris', 'SulAmérica', 'Mapfre', 'AXA', 'Seguros Promo', 'Real Seguro', 'Mondial', 'Bradesco Seguros', 'Itaú Seguros', 'Chubb', 'Zurich', 'Europ Assistance'];
const BANKS = ['Nubank', 'Itaú', 'Bradesco', 'Santander', 'Banco do Brasil', 'Caixa', 'Inter', 'C6 Bank', 'BTG', 'XP', 'Sicredi', 'Sicoob', 'Wise', 'Revolut', 'Nomad', 'Banco Safra', 'PicPay', 'Mercado Pago'];
const TOURS = ['GetYourGuide', 'Get Your Guide', 'Viator', 'Civitatis', 'Klook', 'Tiqets', 'Musement', 'Headout', 'Fever', 'Tripadvisor', 'Airbnb Experiences', 'Guruwalk', 'Freetour', 'Sandemans'];

// Descobre que tipo de documento é, pela faixa MRZ e por palavras típicas
const CLUES = {
  passport:  [[/passaporte|passport|pasaporte/i, 3]],
  visa:      [[/\bvisto\b|\bvisa\b(?!\s*(card|cart[ãa]o|electron|infinite|platinum|gold|signature))|schengen|consulado|consulate/i, 3]],
  id:        [[/carteira\s+de\s+identidade|registro\s+geral|habilita[çc][ãa]o|\bCNH\b|\bRG\b|identity\s+card/i, 4]],
  ticket:    [[/cart[ãa]o\s+de\s+embarque|boarding\s+pass|e-?ticket|bilhete\s+eletr[ôo]nico|ticket\s+(?:number|&\s*receipt)|booking\s+reference|passenger\s+name|conditions\s+of\s+carriage|operated\s+by|itinerary|itiner[áa]rio\s+de\s+voo|localizador/i, 6], [/\bvoo\b|flight|aeroporto|airport|airlines?|companhia\s+a[ée]rea/i, 2], [/port[ãa]o|\bgate\b|assento|poltrona|\bseat\b|bagagem|baggage/i, 1], [/\([A-Z]{3}\)/, 1]],
  stay:      [[/check-?out/i, 3], [/check-?in(?!\s+(?:at\s+the\s+airport|online|points|desk|counter|no\s+aeroporto))/i, 1], [/hotel|pousada|hostel|hospedagem|accommodation|acomoda[çc][ãa]o|booking\.com|airbnb|h[óo]spede|\bguest\b|noites|nights|quarto|room/i, 2]],
  tour:      [[/getyourguide|get your guide|viator|civitatis|klook|tiqets|musement|headout|guruwalk|sandemans/i, 6], [/\btour\b|passeio|excurs[ãa]o|excursion|ingresso|admission|ponto\s+de\s+encontro|meeting\s+point|atividade|activity|experi[êe]ncia/i, 2]],
  insurance: [[/seguro\s+viagem|travel\s+insurance|ap[óo]lice|policy\s+number|assist[êe]ncia\s+(?:em\s+)?viagem|assist\s+card|affinity|travel\s+ace/i, 5], [/seguro|insurance|cobertura|coverage|segurado|insured/i, 2]],
  health:    [[/vacina|vacina[çc][ãa]o|vaccin|imuniza[çc][ãa]o|febre\s+amarela|yellow\s+fever|certificado\s+internacional/i, 5], [/exame|laudo|m[ée]dic[oa]|receita|sa[úu]de|health/i, 1]],
  money:     [[/extrato|statement|saldo|holerite|contracheque|imposto\s+de\s+renda|comprovante\s+de\s+(?:pagamento|transfer[êe]ncia|renda)|\bpix\b|transfer[êe]ncia|ag[êe]ncia\s+\d|conta\s+corrente/i, 4], [/R\$|banco|bank|pagamento|payment|valor/i, 1]],
};
function classify(text, mrz){
  if (mrz) return mrz.kind === 'V' ? 'visa' : mrz.kind === 'I' ? 'id' : 'passport';
  let best = 'other', top = 1;
  for (const [type, rules] of Object.entries(CLUES)) {
    const score = rules.reduce((n, [re, w]) => n + (re.test(text) ? w : 0), 0);
    if (score > top) { best = type; top = score }
  }
  return best;
}

const AIRPORTS = new Set(('GRU CGH VCP GIG SDU BSB CNF SSA REC FOR POA CWB FLN NAT MCZ BEL MAO IGU VIX GYN CGB AJU JPA THE SLZ PMW BPS NVT ' +
  'LIS OPO FAO FNC PDL MAD BCN AGP PMI SVQ VLC BIO IBZ CDG ORY NCE LYS MRS LHR LGW STN LTN MAN EDI DUB FCO MXP LIN VCE NAP BLQ FLR PSA CTA ' +
  'AMS BRU FRA MUC BER DUS HAM ZRH GVA VIE PRG BUD WAW KRK CPH ARN OSL HEL ATH IST SAW AYT KEF ' +
  'JFK EWR LGA BOS MIA FLL MCO TPA ATL ORD IAD DCA DFW IAH LAX SFO SEA LAS DEN PHX YYZ YUL YVR MEX CUN GDL PTY BOG MDE CTG LIM CUZ SCL EZE AEP MVD ASU UIO GYE SJO HAV PUJ SDQ ' +
  'DXB AUH DOH CAI CMN RAK JNB CPT NBO ADD TLV AMM ' +
  'BKK DMK HKT CNX USM SGN HAN DAD CXR PQC REP PNH VTE KUL PEN SIN CGK DPS MNL CEB HKG MFM TPE ICN GMP NRT HND KIX PEK PKX PVG SHA CAN SZX CTU DEL BOM BLR MAA CMB MLE KTM SYD MEL BNE PER AKL').split(' '));
const NOT_AIRPORT = new Set(['CPF', 'BRL', 'USD', 'EUR', 'PDF', 'LTD', 'CNH', 'GMT', 'UTC', 'TAP', 'PNR', 'VAT', 'ATM', 'CEP', 'NIF']);
const PLACES = { BRA:['brasileiro','Brasil'], PRT:['português','Portugal'], ITA:['italiano','Itália'], ESP:['espanhol','Espanha'], D:['alemão','Alemanha'], DEU:['alemão','Alemanha'], FRA:['francês','França'], USA:['americano','Estados Unidos'], ARG:['argentino','Argentina'], GBR:['britânico','Reino Unido'], URY:['uruguaio','Uruguai'], PRY:['paraguaio','Paraguai'], CHL:['chileno','Chile'], JPN:['japonês','Japão'], CAN:['canadense','Canadá'], MEX:['mexicano','México'], POL:['polonês','Polônia'], NLD:['holandês','Holanda'], CHE:['suíço','Suíça'], IRL:['irlandês','Irlanda'], AUS:['australiano','Austrália'], NZL:['neozelandês','Nova Zelândia'], CHN:['chinês','China'], IND:['indiano','Índia'], COL:['colombiano','Colômbia'], PER:['peruano','Peru'], AUT:['austríaco','Áustria'], BEL:['belga','Bélgica'], GRC:['grego','Grécia'], ISR:['israelense','Israel'], ZAF:['sul-africano','África do Sul'], KOR:['sul-coreano','Coreia do Sul'] };

function holderFrom(text){
  const sl = text.match(/(?:passenger(?:\s+name)?|passageiro|nome\s+do\s+passageiro)\s*[:\-]?\s*\n?\s*([A-Z][A-Z' -]{1,40})\/\s*\n?\s*([A-Z][A-Z' ]{1,40})/i);
  if (sl) {
    const giv = sl[2].trim().replace(/\s*(MISS|MRS|MSTR|MR|MS)$/i, '').replace(/(MISS|MRS|MSTR)$/i, '');
    return titleCase(`${giv} ${sl[1].trim()}`);
  }
  const raw = grab(text, /(?:nome\s+do\s+(?:passageiro|segurado|h[óo]spede|titular)|passageiro|passenger(?:\s+name)?|segurado|insured(?:\s+name)?|guest(?:\s+name)?|h[óo]spede|titular|nome(?:\s+civil)?|name)\s*[:\-]?\s*\n?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'´\/ ]{4,48})/i);
  if (!raw) return '';
  let s = raw.split(/\s{2,}|\n/)[0];
  // Formato de companhia aérea: "Sobrenome Nome Ms" → o nome é a última palavra antes do Ms/Mr
  const airline = /\s(MRS|MR|MS|MISS|MSTR)\b\.?\s*$/i.test(s);
  s = s.replace(/\b(MRS|MR|MS|MISS|MSTR|SR|SRA)\b\.?/gi, '').trim();
  if (s.includes('/')) { const [sur, giv] = s.split('/'); s = `${giv} ${sur}` }
  else if (airline) { const w = s.split(/\s+/); if (w.length >= 2) s = [w.pop(), ...w].join(' ') }
  return s.split(' ').length >= 2 ? titleCase(s) : '';
}

const MONEY = /(?:R\$|US\$|USD|EUR|€|£|GBP|\$)\s?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})?|\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s?(?:EUR|€|USD|BRL|reais)/i;
const money = (T, re) => { const m = T.match(re); return m ? (m[1].match(MONEY) || [m[1]])[0].replace(/\s+/g, ' ').trim() : '' };
// Hora (HH:MM) logo depois de um rótulo
const timeAfter = (T, re) => { const m = T.match(re); return m ? m[1].replace(/h/i, ':').padStart(5, '0') : '' };

function fromText(type, text){
  const r = { x: {} }, X = r.x, dates = findDates(text), fut = future(dates), T = text;
  // rótulo e valor podem estar em linhas diferentes (comum em PDF e OCR)
  const exp = near(dates, /(validade|v[áa]lid[oa]\s+at[ée]|valid\s+(?:until|thru|through)|expira|expiry|expiration|vencimento)[\s\S]{0,30}$/i);
  if (MRZ_TYPES.has(type)) {
    r.issued = near(dates, /(expedi[çc][ãa]o|emiss[ãa]o|issue|issued|d[ée]livrance)[\s\S]{0,30}$/i);
    r.birth = near(dates, /(nascimento|birth|naissance)[\s\S]{0,30}$/i);
  }
  switch (type) {
    case 'ticket': {
      r.number = grab(T, /(?:localizador|c[óo]digo\s+(?:de\s+)?(?:reserva|confirma[çc][ãa]o)|booking\s+(?:reference|code|ref\.?)|record\s+locator|reservation\s+(?:code|number)|confirmation\s+(?:code|number)|pnr|reserva)\s*(?:n[º°o.]*)?\s*[:#\-]?\s*\n?\s*([A-Z0-9]{6})\b/i, upperCode);
      const codes = [...T.matchAll(/\(([A-Z]{3})\)/g)].map(m => m[1]).filter(c => !NOT_AIRPORT.has(c));
      let [org, dst] = [...new Set(codes)], short = '';
      // Códigos soltos só valem se forem aeroportos conhecidos (evita "NON para END")
      if (!dst) { const m = T.match(/\b([A-Z]{3})\s*(?:-|–|→|>)\s*([A-Z]{3})\b/); if (m && AIRPORTS.has(m[1]) && AIRPORTS.has(m[2])) [org, dst] = [m[1], m[2]] }
      const city = code => { const m = T.match(new RegExp('([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .\'\\-]{2,28}?)\\s*\\(' + code + '\\)')); return m ? `${titleCase(m[1].replace(/^(de|para|from|to)\s+/i, ''))} (${code})` : code };
      if (org && dst) { X.route = `${city(org)} para ${city(dst)}`; short = `${org} para ${dst}` }
      else {
        // Tabela "From / To" com o nome do aeroporto: "BANGKOK SUVARNABHUMI INTL, TH  HANOI NOI BAI INTL, VN"
        const ports = [...T.matchAll(/\b([A-Z][A-Z'.-]{2,})(?:\s+[A-Z][A-Z'.-]*){0,4}?\s+(?:INTL|INTERNATIONAL|AIRPORT|AEROPORTO|AIRPT)\b/g)].map(m => titleCase(m[1]));
        if (ports.length >= 2) X.route = short = `${ports[0]} para ${ports[1]}`;
      }
      // Companhia: a que mais aparece no texto (evita "United" de "United States")
      let air = '', hits = 0;
      for (const a of AIRLINES) { const n = (T.match(new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi')) || []).length; if (n > hits) { air = a; hits = n } }
      if (!air) air = (T.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s(?:Airlines|Airways|Air Lines))\b/) || [])[1] || '';
      X.flight = grab(T, /\b(?:voo|flight|vuelo)\s*(?:n[º°o.]*)?\s*:?\s*([A-Z0-9]{2}\s?\d{2,4})\b/i).toUpperCase().replace(/\s+/, ' ');
      // Voo numa tabela, logo antes do horário: "VN610 12:20"
      if (!X.flight) { const m = T.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\s+\d{1,2}:\d{2}\b/); if (m) X.flight = `${m[1]} ${m[2]}` }
      X.seat = grab(T, /(?:assento|poltrona|seat|asiento)\s*(?:n[º°o.]*)?\s*[:\-]?\s*(\d{1,2}\s?[A-K])\b/i).replace(/\s/, '').toUpperCase();
      X.group = grab(T, /(?:grupo(?:\s+de\s+embarque)?|boarding\s+group|group|zona|zone)\s*[:\-]?\s*([A-Z0-9]{1,2})\b/i).toUpperCase();
      X.gate = grab(T, /(?:port[ãa]o(?:\s+de\s+embarque)?|gate|puerta)\s*[:\-]?\s*([A-Z]?\d{1,3}[A-Z]?)\b/i).toUpperCase();
      // dia do voo: a 1ª data com horário colado (antes ou depois); ignora a data de emissão do bilhete
      const timeBefore = d => (T.slice(Math.max(0, d.i - 14), d.i).match(/(\d{1,2}[:h]\d{2})\s*$/) || [])[1];
      const timeNext = d => (T.slice(d.i, d.i + 30).match(/^\S+(?:\s\S+){0,2}?\s+(\d{1,2}[:h]\d{2})\b/) || [])[1];
      const flightDay = fut.find(d => timeBefore(d) || timeNext(d)) || fut.find(d => !/emiss|issu|date:\s*$/i.test(d.ctx.slice(-25))) || fut[0];
      const day = flightDay?.date;
      // decolagem: rótulo explícito, ou a hora colada na data do voo
      let dep = timeAfter(T, /(?:decolagem|partida|sa[íi]da|departure|departs?|hor[áa]rio\s+do\s+voo)[^\d\n]{0,25}(?:\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\s+)?(\d{1,2}[:h]\d{2})\b/i);
      if (!dep && flightDay) { const t = timeBefore(flightDay) || timeNext(flightDay); if (t) dep = t.replace(/h/i, ':').padStart(5, '0') }
      const brd = timeAfter(T, /(?:embarque|boarding)(?:\s+time|\s+[àa]s|\s+at)?[^\d\n]{0,20}(\d{1,2}[:h]\d{2})\b/i);
      if (day && dep) X.departure = `${day}T${dep}`;
      if (day && brd) X.boarding = `${day}T${brd}`;
      // Outros dados úteis da passagem, cada um no seu campo
      const timed = fut.filter(d => timeBefore(d) || timeNext(d));
      const arrT = timeAfter(T, /(?:chegada|arrival|arrives?|llegada)[^\d\n]{0,25}(\d{1,2}[:h]\d{2})\b/i) || (timed[1] && (timeBefore(timed[1]) || timeNext(timed[1])) || '').replace(/h/i, ':').padStart(5, '0');
      if (arrT && arrT !== '00000' && arrT !== dep) X.arrival = `${timed[1]?.date || day}T${arrT}`;
      X.terminal = grab(T, /terminal\s*[:\-]?\s*([A-Z0-9]{1,3})\b/i).toUpperCase();
      const cls = grab(T, /(?:classe|class|cabin|cabine)\s*[:\-]\s*([A-Za-z][A-Za-z ]{2,24}?)\s*(?:,|\n|\s{2}|$)/i); if (cls) X.class = titleCase(cls);
      const bag = grab(T, /(?:free\s+checked\s+baggage|checked\s+bag(?:gage)?|baggage\s+allowance|franquia\s+de\s+bagagem|bagagem\s+despachada|bagagem|baggage)\s*[:\-]?\s*(\d+\s*(?:PC|pe[çc]as?|pieces?|kg|x\s*\d+\s*kg)?)/i);
      if (bag) X.baggage = bag.replace(/(\d+)\s*(PC|pieces?|pe[çc]as?)/i, (_, n) => `${n} ${+n === 1 ? 'peça' : 'peças'}`);
      X.eticket = grab(T, /(?:ticket\s+(?:number|no\.?)|n[úu]mero\s+do\s+bilhete|e-?ticket\s*(?:n[º°o.]*)?)\s*[:\-]?\s*(\d{3}[\s-]?\d{10})\b/i);
      const dur = grab(T, /(?:dura[çc][ãa]o|duration)\s*[:\-]?\s*(\d{1,2}[:h]\d{2})/i); if (dur) { const [h, m] = dur.split(/[:h]/i); r.notes = `Duração do voo: ${+h}h${m}` }
      const legs = parseLegs(T);
      if (legs.length > 1) {
        const now = new Date().toISOString().slice(0, 16);
        const next = legs.find(l => (l.dep || '') >= now) || legs[0];
        const first = legs[0], last = legs[legs.length - 1];
        const round = last.toCode === first.fromCode;
        const dest = round ? legs[Math.ceil(legs.length / 2) - 1] : last;
        const stops = [...new Set(legs.slice(0, round ? Math.ceil(legs.length / 2) : legs.length).slice(0, -1).map(l => l.to))];
        X.route = `${first.from} (${first.fromCode}) para ${dest.to} (${dest.toCode})${round ? ', ida e volta' : ''}${stops.length ? `, via ${stops.join(', ')}` : ''}`;
        short = `${first.fromCode} para ${dest.toCode}${round ? ' ida e volta' : ''}`;
        // quadradinhos mostram o próximo voo
        for (const k of ['flight', 'departure', 'arrival', 'boarding', 'terminal', 'seat', 'gate']) delete X[k];
        if (next.flight) X.flight = next.flight;
        if (next.dep) X.departure = next.dep;
        if (next.arr) X.arrival = next.arr;
        if (next.terminal) X.terminal = next.terminal;
        if (next.seat) X.seat = next.seat;
        const br = v => v ? `${fmtBR(v.slice(0, 10)).slice(0, 5)}${v.length > 10 ? ' ' + v.slice(11, 16) : ''}` : '';
        r.notes = ['Voos deste bilhete:', ...legs.map((l, i) => `${i + 1}. ${l.fromCode} para ${l.toCode}${l.flight ? ', ' + l.flight : ''}${l.dep ? ', sai ' + br(l.dep) : ''}${l.arr ? ', chega ' + br(l.arr) : ''}`), r.notes].filter(Boolean).join('\n');
        r.start = first.dep?.slice(0, 10) || r.start; r.end = (last.arr || last.dep || '').slice(0, 10) || r.end;
      }
      r.title = [air || 'Passagem', short].filter(Boolean).join(' ');
      r.start = day; r.end = latest(fut);
      break;
    }
    case 'stay': {
      r.number = grab(T, /(?:n[úu]mero\s+(?:da\s+)?(?:reserva|confirma[çc][ãa]o)|c[óo]digo\s+(?:da\s+)?reserva|localizador|confirma[çc][ãa]o|confirmation\s*(?:number|no\.?|#|code)?|booking\s*(?:number|no\.?|id|#|reference)|reserva\s*(?:n[º°o.]*|#))\s*[:#]?\s*\n?\s*([A-Z0-9][A-Z0-9.\-]{4,20})\b/i, s => /\d/.test(s));
      const lines = T.split('\n').map(l => l.trim());
      const hotel = lines.find(l => l.length <= 60 && /\b(hotel|pousada|hostel|resort|inn|suites|apart|residence|albergue|apartamento|guesthouse|b&b)\b/i.test(l) && !/check|reserva|confirma|endere/i.test(l)) || '';
      const plat = oneOf(T, STAYS);
      X.hotel = hotel ? titleCase(hotel).replace(/\bhotel\b/i, 'Hotel') : '';
      X.address = grab(T, /(?:endere[çc]o|address|localiza[çc][ãa]o|direcci[óo]n)\s*[:\-]?\s*\n?\s*([^\n]{8,120})/i)
        || lines.find(l => l.length <= 120 && /\b(rua|r\.|av\.?|avenida|alameda|travessa|pra[çc]a|largo|rodovia|street|st\.|road|rd\.|avenue|ave\.|calle|via|rue|strasse|straße|platz)\b/i.test(l) && /\d/.test(l)) || '';
      r.title = X.hotel || (plat ? `Hospedagem ${plat}` : 'Hospedagem');
      X.checkin = near(dates, /(check-?in|entrada|chegada|arrival)\b[\s\S]{0,25}$/i) || fut[0]?.date || '';
      X.checkout = near(dates, /(check-?out|sa[íi]da|partida|departure)\b[\s\S]{0,25}$/i) || latest(fut) || '';
      r.start = X.checkin; r.end = X.checkout;
      // Outros dados úteis da reserva, cada um no seu campo
      if (plat && hotel) r.notes = `Reservado pelo ${plat}`;
      X.checkinTime = timeAfter(T, /check-?in[^\n]{0,40}?(?:a\s+partir\s+d[aeo]s?|from|após|after|desde)\s*(\d{1,2}[:h]\d{2})/i);
      X.checkoutTime = timeAfter(T, /check-?out[^\n]{0,40}?(?:at[ée]|until|before|antes\s+d[aeo]s?|hasta)\s*(\d{1,2}[:h]\d{2})/i);
      X.phone = grab(T, /(?:telefone|phone|tel\.?|fone)\s*[:\-]?\s*(\+?\d[\d\s().\-]{7,20}\d)/i).trim();
      X.total = money(T, /(?:pre[çc]o\s+total|valor\s+total|total\s+price|total\s+a\s+pagar|total)\s*[:\-]?\s*([^\n]{2,30})/i);
      X.nights = grab(T, /(\d{1,2})\s*(?:noites?|nights?)\b/i);
      break;
    }
    case 'insurance': {
      r.number = grab(T, /(?:ap[óo]lice|voucher|certificado|bilhete|policy|n[º°o.]?\s*do\s*seguro)\s*(?:n[º°o.]*|number|no\.?)?\s*[:#]?\s*\n?\s*([A-Z0-9][A-Z0-9.\-\/]{4,24})\b/i, s => /\d/.test(s));
      const ins = oneOf(T, INSURERS);
      r.title = ins ? `Seguro ${ins}` : 'Seguro viagem';
      X.phone = grab(T, /(?:central\s+de\s+(?:atendimento|emerg[êe]ncia)|emerg[êe]ncia|emergency|assist[êe]ncia\s+24\s*h?|whatsapp|telefone|phone)[^\n+]{0,30}?(\+?\d[\d\s().\-]{7,20}\d)/i).trim();
      X.value = money(T, /(?:valor\s+(?:da\s+)?ap[óo]lice|valor\s+segurado|cobertura(?:\s+m[ée]dica)?|despesas\s+m[ée]dicas|medical|capital\s+segurado)[^\n]{0,60}?((?:R\$|US\$|USD|EUR|€|£)\s?[\d.,]{3,}|[\d.,]{3,}\s?(?:EUR|€|USD))/i)
        || money(T, /(?:valor\s+total|total\s+pago|pr[êe]mio|total)[^\n]{0,30}?((?:R\$|US\$|USD|EUR|€)\s?[\d.,]{3,})/i);
      r.start = near(dates, /(in[íi]cio|de|from|vig[êe]ncia|sa[íi]da)\s*[:\-]?\s*$/i) || fut[0]?.date;
      r.end = near(dates, /(fim|t[ée]rmino|at[ée]|to|until|retorno|volta)\s*[:\-]?\s*$/i) || latest(fut);
      r.expires = r.end;
      break;
    }
    case 'money': {
      const bank = oneOf(T, BANKS);
      X.place = grab(T, /(?:estabelecimento|local|favorecido|recebedor|benefici[áa]rio|merchant|loja|empresa)\s*[:\-]\s*([^\n]{3,60})/i) || bank;
      X.date = near(dates, /(data(?:\s+da\s+transa[çc][ãa]o|\s+do\s+pagamento)?|date|em)\s*[:\-]?\s*$/i) || latest(dates) || '';
      X.value = money(T, /(?:valor(?:\s+total|\s+pago)?|total|saldo(?:\s+final|\s+dispon[íi]vel)?|amount|quantia)\s*[:\-]?\s*\n?\s*([^\n]{2,30})/i) || (T.match(MONEY) || [''])[0].trim();
      const mon = X.date ? new Date(X.date + 'T00:00').toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', '').replace(' de ', '/') : '';
      const kind = /extrato|statement/i.test(T) ? 'Extrato' : /holerite|contracheque|payslip/i.test(T) ? 'Holerite' : /imposto|irpf|declara[çc][ãa]o/i.test(T) ? 'Declaração de IR' : /comprovante|recibo|receipt/i.test(T) ? 'Comprovante' : 'Comprovante financeiro';
      r.title = [kind, bank, mon].filter(Boolean).join(' ');
      break;
    }
    case 'health': {
      const v = /febre\s+amarela|yellow\s+fever/i.test(T) ? 'Febre amarela' : /covid|sars-cov/i.test(T) ? 'Covid-19' : /sarampo|measles|tr[íi]plice/i.test(T) ? 'Sarampo' : /poliomielite|polio/i.test(T) ? 'Poliomielite' : /hepatite\s*[ab]?/i.test(T) ? titleCase(T.match(/hepatite\s*[ab]?/i)[0]) : /t[ée]tano|dtpa|dupla\s+adulto/i.test(T) ? 'Tétano' : '';
      const civp = /certificado\s+internacional|international\s+certificate/i.test(T);
      X.what = v ? `Vacina ${v.toLowerCase()}` : civp ? 'Certificado internacional de vacinação' : /exame|laudo|resultado/i.test(T) ? 'Exame' : /receita|prescri/i.test(T) ? 'Receita médica' : '';
      X.date = near(dates, /(data|date|aplica[çc][ãa]o|vacina[çc][ãa]o|dose)[\s\S]{0,20}$/i) || dates[0]?.date || '';
      r.number = grab(T, /(?:n[º°o.]?\s*(?:do\s+)?(?:certificado|registro|documento)|(?:certificado|registro)\s*n[º°o.]*|certificate\s*(?:no\.?|number)|lote|batch|lot)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{3,20})\b/i, s => /\d/.test(s));
      r.title = civp ? `Certificado internacional de vacinação${v ? ` (${v.toLowerCase()})` : ''}` : X.what;
      break;
    }
    case 'tour': {
      const op = oneOf(T, TOURS);
      r.number = grab(T, /(?:localizador|c[óo]digo\s+(?:de\s+)?(?:reserva|confirma[çc][ãa]o)|refer[êe]ncia(?:\s+da\s+reserva)?|booking\s+(?:reference|code|ref\.?|number|id)|confirmation\s+(?:code|number)|order\s*(?:number|#)|reserva\s*(?:n[º°o.]*|#)?)\s*[:#\-]?\s*\n?\s*([A-Z0-9][A-Z0-9\-]{4,20})\b/i, s => /\d/.test(s) || /^[A-Z]{6,}$/.test(s));
      const lines = T.split('\n').map(l => l.trim());
      const name = lines.find(l => l.length >= 8 && l.length <= 90 && /\b(tour|passeio|visita|ingresso|entrada|ticket|excurs[ãa]o|excursion|experi[êe]ncia|cruzeiro|cruise|museu|museum|aula|class|show|day trip|bate-volta|degusta[çc][ãa]o|tasting)\b/i.test(l) && !/getyourguide|viator|civitatis|klook|tiqets|voucher|confirma|obrigad|thank/i.test(l)) || '';
      X.name = name;
      X.what = /museu|museum|ingresso|entrada|admission|skip.the.line/i.test(T) ? 'Ingresso' : /excurs|day trip|bate-volta/i.test(T) ? 'Excursão' : /cruzeiro|cruise|barco|boat|catamar/i.test(T) ? 'Passeio de barco' : /degusta|tasting|vin[íi]cola|winery|food tour/i.test(T) ? 'Degustação' : /aula|class|workshop|oficina/i.test(T) ? 'Aula' : /show|espet[áa]culo|concert|fado|flamenco/i.test(T) ? 'Show' : /tour|passeio|visita|walking/i.test(T) ? 'Passeio guiado' : '';
      X.date = near(dates, /(data|date|dia|quando|when)[\s\S]{0,20}$/i) || fut[0]?.date || '';
      const tm = timeAfter(T, /(?:hor[áa]rio|hora|time|in[íi]cio|starts?|come[çc]a)[^\d\n]{0,20}(\d{1,2}[:h]\d{2})\b/i);
      if (tm) X.time = tm;
      const meet = grab(T, /(?:ponto\s+de\s+encontro|meeting\s+point|local\s+de\s+encontro|punto\s+de\s+encuentro)\s*[:\-]?\s*\n?\s*([^\n]{6,120})/i);
      X.meeting = meet;
      if (op) r.notes = `Reservado pelo ${op}`;
      r.title = name ? name.slice(0, 60) : op ? `Tour ${op}` : 'Tour';
      r.start = r.end = X.date;
      break;
    }
    case 'id': {
      const cnh = /habilita[çc][ãa]o|\bCNH\b|driver/i.test(T);
      r.title = cnh ? 'CNH' : /registro\s+geral|\bRG\b/i.test(T) ? 'RG' : /identidade|identity/i.test(T) ? 'Carteira de identidade' : '';
      r.number = cnh ? grab(T, /registro\s*[:\n\s]*(\d{9,11})\b/i) : grab(T, /(?:registro\s+geral|\bRG\b)\s*[:nº°.\s]*([\d.\-xX]{7,14})/i);
      const cpf = grab(T, /\bCPF\b\s*[:\n\s]*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/i);
      if (cpf) r.notes = `CPF ${cpf}`;
      if (!r.number && cpf) r.number = cpf;
      r.expires = exp;
      break;
    }
    case 'passport':
      r.number = grab(T, /(?:passport\s*no\.?|n[º°o.]?\s*do\s*passaporte|passaporte\s*n[º°o.]?|n[º°o.]\s*passaporte)\s*[:\/]?\s*\n?\s*([A-Z]{1,2}\d{6,8})\b/i);
      r.expires = exp;
      X.issued = r.issued || '';
      break;
    case 'visa': {
      const kind = grab(T, /(?:tipo\s+de\s+visto|visa\s+type|type\s+of\s+visa|categoria|tipo|type)\s*[:\/]?\s*([A-Z]{1,2}\d{0,2}(?:-\d)?)\b/i);
      r.title = kind ? `Visto ${kind.toUpperCase()}` : '';
      r.number = grab(T, /(?:visa\s*n[º°o.]*|n[º°o.]\s*do\s*visto|control\s+number|n[úu]mero)\s*[:#]?\s*([A-Z0-9]{6,12})\b/i, s => /\d/.test(s));
      r.expires = near(dates, /(until|at[ée]|expira|expiration|expiry|validade|v[áa]lido)[\s\S]{0,30}$/i) || exp;
      const pl = grab(T, /(?:local\s+de\s+emiss[ãa]o|place\s+of\s+issue|issued\s+(?:at|in)|emitido\s+em|lugar\s+de\s+expedici[óo]n)\s*[:\/]?\s*\n?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .\-]{2,40})/i);
      X.place = pl ? titleCase(pl) : '';
      break;
    }
    default: {
      const first = T.split('\n').map(l => l.trim()).find(l => l.length >= 6 && l.length <= 60 && /[a-zà-ÿ]{3}/i.test(l) && !/\d{4,}/.test(l));
      r.title = first ? titleCase(first) : '';
      r.expires = exp;
    }
  }
  for (const k in X) if (!X[k]) delete X[k];
  r.holder = holderFrom(T);
  r.dates = fut.map(d => d.date);
  return r;
}

/* ---------- Ponto de entrada ---------- */
async function openPdf(file){
  const lib = await pdfjs();
  return lib.getDocument({ data: new Uint8Array(await file.blob.arrayBuffer()), isEvalSupported: false }).promise;
}
async function pdfText(pdf){
  let text = '';
  for (let p = 1; p <= Math.min(pdf.numPages, 6); p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    for (const it of tc.items) if ('str' in it) text += it.str + (it.hasEOL ? '\n' : ' ');
    text += '\n';
  }
  return text;
}
async function renderPage(pdf, n, width = 2400){
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return c;
}
// Miniatura da 1ª página, para o cartão do documento
async function pdfThumb(blob, width = 360){
  const c = await renderPage(await openPdf({ blob }), 1, width);
  return new Promise(r => c.toBlob(r, 'image/jpeg', .8));
}

const MRZ_TYPES = new Set(['passport', 'visa', 'id']);
// Foto: a faixa costuma estar embaixo. PDF: o documento pode estar em qualquer lugar da página.
const PHOTO_TRIES = [{ crop: [.55, 1], maxW: 1800 }, { crop: [.3, 1], maxW: 1800 }, { maxW: 2200 }, { rotate: 90, maxW: 2200 }, { rotate: 270, maxW: 2200 }];
const PDF_FIRST = [{ maxW: 3000 }, { crop: [.5, 1], maxW: 2400 }, { rotate: 90, maxW: 3000 }, { rotate: 270, maxW: 3000 }];
const PDF_REST = [{ maxW: 3000 }];

// forcedType vazio = o Carimbo descobre o tipo sozinho
async function read(files, forcedType, status = () => {}){
  const engine = async () => { if (!ocrP) status('Preparando o leitor. Isso só demora na primeira vez…'); await ocr() };
  let allText = '', mrz = null;
  for (const f of files) {
    const isPdf = f.type === 'application/pdf';
    let t = '', pages = [];
    if (isPdf) {
      status('Lendo o PDF…');
      const pdf = await openPdf(f);
      t = await pdfText(pdf);
      pages = Array.from({ length: Math.min(pdf.numPages, 3) }, (_, i) => () => renderPage(pdf, i + 1));
    } else if (f.type.startsWith('image/')) pages = [() => f.blob];
    const hasText = t.replace(/\s/g, '').length > 40;
    if (!mrz && hasText) mrz = parseMRZ(t);
    // Só procura a faixa MRZ nas imagens quando parece documento pessoal (ou ainda não dá para saber)
    const guess = forcedType || classify(t, mrz);
    const seekMRZ = !mrz && (MRZ_TYPES.has(guess) || (!forcedType && guess === 'other'));
    if (pages.length && (!hasText || seekMRZ)) {
      await engine();
      for (const [i, get] of pages.entries()) {
        status(i ? `Procurando na página ${i + 1}…` : 'Lendo o documento…');
        const pg = await ocrPage(await get(), isPdf ? 3000 : 2400);
        if (!hasText && i === 0) t = (t + '\n' + pg.text).trim();
        if (!mrz) mrz = parseMRZ(pg.text);
        if (!mrz) { status('Lendo a faixa de códigos…'); mrz = await mrzFromPage(pg) }
        if (!mrz && i === 0 && pg.text.replace(/\s/g, '').length < 60) {
          status('Procurando com a imagem girada…');
          mrz = await readMRZ(await get(), status, isPdf ? PDF_FIRST.slice(2) : PHOTO_TRIES.slice(3));
        }
        if (mrz) break;
        // Páginas seguintes só valem a pena para passaporte/visto/RG
        if (!MRZ_TYPES.has(forcedType || classify(t, null))) break;
      }
    }
    allText += t + '\n';
  }

  const type = forcedType || classify(allText, mrz);
  const out = { type, detected: !forcedType, filled: [], x: {} };
  const set = (k, v) => { if (v && !out[k]) { out[k] = v; out.filled.push(k) } };
  const setx = (k, v) => { if (v && !out.x[k]) { out.x[k] = v; out.filled.push('x.' + k) } };

  if (mrz && MRZ_TYPES.has(type)) {
    set('number', mrz.number); set('holder', mrz.holder); set('expires', mrz.expires);
    const nat = PLACES[mrz.nationality]?.[0], place = PLACES[mrz.country]?.[1];
    if (type === 'passport') set('title', nat ? `Passaporte ${nat}` : 'Passaporte');
    if (type === 'visa') { set('title', place ? `Visto ${place}` : 'Visto'); setx('place', place) }
    if (type === 'id' && mrz.kind === 'I') set('title', 'Carteira de identidade');
    out.birth = mrz.birth; out.nationality = mrz.nationality;
    out.mrz = true; out.numberOk = mrz.numberOk;
    if (out.holder && allText.trim()) out.holder = fixName(out.holder, allText);
  }
  if (allText.trim()) {
    const r = fromText(type, allText);
    for (const k of ['title', 'number', 'holder', 'expires', 'notes']) set(k, r[k]);
    for (const [k, v] of Object.entries(r.x || {})) setx(k, v);
    out.start = r.start; out.end = r.end; out.birth ||= r.birth;
    out.dates = r.dates;
  }
  // Documentos pessoais: nascimento e nacionalidade vão para as observações
  if (MRZ_TYPES.has(type)) {
    const br = d => d.split('-').reverse().join('/');
    const extra = [out.birth && `Nascimento: ${br(out.birth)}`, PLACES[out.nationality] && `Nacionalidade: ${PLACES[out.nationality][1]}`].filter(Boolean);
    if (extra.length) {
      out.notes = [out.notes, ...extra].filter(Boolean).join('\n');
      if (!out.filled.includes('notes')) out.filled.push('notes');
    }
  }
  out.text = allText.trim().slice(0, 8000);
  return out;
}

window.Extract = { read, parseMRZ, fromText, classify, findDates, pdfThumb, warm: () => ocr().catch(() => {}) };
})();
