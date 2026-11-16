'use strict';

/* Field extraction for identity cards (NADRA CNIC / NICOP / old NIC).
 *
 * OCR text is messy: labels and values land on different lines, columns get
 * split, Urdu and English are mixed, digits may be Arabic-Indic. This turns
 * that soup into a small set of named fields so boilerplate like "ISLAMIC
 * REPUBLIC OF PAKISTAN" or "Registrar General of Pakistan" is dropped.
 */

const Fields = (() => {
  /* ------------------------------------------------------------ helpers */

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
  const EN_DIGITS = '01234567890123456789';

  function normDigits(s) {
    return String(s).replace(/[٠-٩۰-۹]/g, (ch) => {
      const i = AR_DIGITS.indexOf(ch);
      return i === -1 ? ch : EN_DIGITS[i];
    });
  }

  function cleanLine(s) {
    return String(s)
      .replace(/[‘’´`“”]/g, "'")
      .replace(/[|｜]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/^[\s\-–—•·.'"/\\]+|[\s\-–—•·.'"/\\]+$/g, '')
      .trim();
  }

  const NOISE =
    /(islamic\s*republic|national\s*identity|identity\s*card|holder'?s?\s*(signature|name)?\s*$|registrar\s*general|government\s*of\s*pakistan|nadra|دستخط|رجسٹرار|حکومتِ?\s*پاکستان|قومی\s*شناختی\s*کارڈ)/i;

  function looksLikeName(v) {
    if (!v) return false;
    const s = String(v).trim();
    if (s.length < 2 || s.length > 48) return false;
    if (NOISE.test(s)) return false;
    if (/^[\d\s.\-/:]+$/.test(s)) return false;
    if (/^(name|father'?s? name|husband'?s? name|mother'?s? name|holder'?s? name|gender|country( of stay)?|date of (birth|issue|expiry))$/i.test(s)) return false;
    if (/(date|number|gender|country|birth|issue|expiry|signature|identity|address|پیدائش|تاریخ)/i.test(s)) return false;
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (letters < 2) return false;
    const digits = (s.match(/\d/g) || []).length;
    if (digits > s.length / 3) return false;
    return true;
  }

  function isLatinOnly(v) {
    return /^[A-Za-z .'\-]+$/.test(String(v).trim());
  }

  /* -------------------------------------------------------------- dates */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function valid(y, m, d) {
    return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  }

  function toDate(str) {
    const s = normDigits(str).replace(/[۔]/g, '.');
    const m = s.match(/(\d{1,4})\s*[.\/\-]\s*(\d{1,2})\s*[.\/\-]\s*(\d{1,4})/);
    if (!m) return null;

    let a = +m[1];
    let b = +m[2];
    let c = +m[3];

    if (a > 31) {
      const y = a;
      if (!valid(y, b, c)) return null;
      return { d: c, m: b, y, iso: `${y}-${pad(b)}-${pad(c)}`, text: `${pad(c)}.${pad(b)}.${y}` };
    }

    const y = c < 100 ? 2000 + c : c;
    if (!valid(y, b, a)) return null;
    return { d: a, m: b, y, iso: `${y}-${pad(b)}-${pad(a)}`, text: `${pad(a)}.${pad(b)}.${y}` };
  }

  function findDates(line) {
    const out = [];
    const s = normDigits(line);
    const re = /\d{1,4}\s*[.\/\-]\s*\d{1,2}\s*[.\/\-]\s*\d{1,4}/g;
    let m;
    while ((m = re.exec(s))) {
      const dt = toDate(m[0]);
      if (dt) out.push({ ...dt, index: m.index });
    }
    return out;
  }

  /** positions of date labels on a line, so dates can be mapped left→right */
  function dateLabelPositions(line) {
    const out = [];
    for (const key of ['dob', 'issue', 'expiry']) {
      const m = line.match(LABELS[key]);
      if (m) out.push({ key, index: m.index });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  function findCnic(text) {
    const s = normDigits(text);
    const dashed = s.match(/\b\d{5}\s*-\s*\d{7}\s*-\s*\d\b/);
    if (dashed) return dashed[0].replace(/\s+/g, '');

    // OCR sometimes drops the dashes or splits the groups
    const plain = s.match(/\b\d{13}\b/);
    if (plain) {
      const v = plain[0];
      return `${v.slice(0, 5)}-${v.slice(5, 12)}-${v.slice(12)}`;
    }
    const spaced = s.match(/\b\d{5}\s+\d{7}\s+\d\b/);
    if (spaced) {
      const v = spaced[0].replace(/\s+/g, '');
      return `${v.slice(0, 5)}-${v.slice(5, 12)}-${v.slice(12)}`;
    }
    return '';
  }

  /* ------------------------------------------------------------- labels */

  const LABELS = {
    fatherName: /(father\s*'?s?\s*name|father|husband\s*'?s?\s*name|husband|والد\s*کا\s*نام|ولدیت|والد)/i,
    cnic: /(identity\s*number|id\s*number|card\s*no|شناختی\s*نمبر|قومی\s*شناختی)/i,
    dob: /(date\s*of\s*birth|\bd\.?o\.?b\.?\b|تاریخ\s*پیدائش|پیدائش)/i,
    expiry: /(date\s*of\s*expiry|date\s*of\s*expire|expiry|valid\s*(up\s*to|till|until)|تاریخ\s*اختتام|اختتام)/i,
    issue: /(date\s*of\s*issue|تاریخ\s*اجرا|اجرا)/i,
    address: /(\baddress\b|رہائشی\s*پتہ|پتہ)/i,
    gender: /(\bgender\b|\bsex\b|جنس)/i,
    country: /(country\s*of\s*stay|nationality|قومیت)/i,
    name: /((?:holder'?s?\s*)?\bname\b|^نام|نام\s*[:：])/i
  };

  const PRIORITY = ['fatherName', 'cnic', 'dob', 'expiry', 'issue', 'address', 'gender', 'country', 'name'];

  const KEY_LABEL = {
    name: 'Name',
    fatherName: 'Father Name',
    cnic: 'CNIC',
    dob: 'Date of Birth',
    issue: 'Date of Issue',
    expiry: 'Date of Expiry',
    gender: 'Gender',
    country: 'Country',
    address: 'Address'
  };

  const ORDER = ['name', 'fatherName', 'cnic', 'dob', 'issue', 'expiry', 'gender', 'country', 'address'];

  function labelOf(line) {
    const isFather = LABELS.fatherName.test(line);
    for (const key of PRIORITY) {
      if (key === 'name' && isFather) continue; // "Father Name" is not the holder name
      if (LABELS[key].test(line)) return key;
    }
    return null;
  }

  function stripLabel(line, key) {
    const re = LABELS[key];
    const m = line.match(re);
    if (!m) return cleanLine(line);
    const rest = line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length);
    return cleanLine(rest.replace(/[:：]/g, ' '));
  }

  function dateLabelOf(line) {
    for (const key of ['dob', 'expiry', 'issue']) {
      if (LABELS[key].test(line)) return key;
    }
    return null;
  }

  /* --------------------------------------------------------- extraction */

  function valueFrom(line, key) {
    let v = stripLabel(line, key);

    if (key === 'name' || key === 'fatherName') {
      return looksLikeName(v) ? v : '';
    }
    if (key === 'cnic') {
      return findCnic(v);
    }
    if (key === 'dob' || key === 'issue' || key === 'expiry') {
      const d = findDates(v)[0];
      return d ? d.text : '';
    }
    if (key === 'gender') {
      const g = v.match(/\b(male|female|m|f)\b|(مرد|عورت)/i);
      if (!g) return '';
      const val = (g[1] || g[2] || '').toLowerCase();
      if (val === 'm' || val === 'male' || val === 'مرد') return 'M';
      return 'F';
    }
    if (key === 'country') {
      const c = v.match(/\b(pakistan|پاکستان)\b/i);
      return c ? 'Pakistan' : '';
    }
    if (key === 'address') {
      return v.length >= 4 ? v : '';
    }
    return v;
  }

  function nextValue(lines, i, key) {
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const line = lines[j];
      if (!line) continue;
      if (labelOf(line)) return '';
      const v = valueFrom(line, key);
      if (v) return v;
    }
    return '';
  }

  /**
   * @param {string} rawText OCR text
   * @returns {{fields: Record<string,string>, order: string[], labels: Record<string,string>, found: number}}
   */
  function extract(rawText) {
    const text = normDigits(String(rawText || '')).replace(/\r/g, '');
    const lines = text.split('\n').map(cleanLine).filter(Boolean);

    const out = {
      name: '',
      fatherName: '',
      cnic: '',
      dob: '',
      issue: '',
      expiry: '',
      gender: '',
      country: '',
      address: ''
    };

    out.cnic = findCnic(text);

    /* ---- pass 1: labels with a value on the same line or the next lines */
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const key = labelOf(line);
      if (!key || out[key]) continue;

      // two-column rows ("Date of Issue  Date of Expiry") are handled by pass 2
      if ((key === 'dob' || key === 'issue' || key === 'expiry') && dateLabelPositions(line).length > 1) continue;

      let v = valueFrom(line, key);
      if (!v) v = nextValue(lines, i, key);
      if (v) out[key] = v;
    }

    /* ---- pass 2: dates, matched to the nearest date label above them */
    const hits = [];
    lines.forEach((line, i) => {
      findDates(line).forEach((d) => hits.push({ d, i }));
    });

    for (const hit of hits) {
      if (hit.used) continue;

      /* two-column date rows: "Date of Issue     Date of Expiry"
         + next line "16.08.2019   16.08.2029" → map left→right */
      if (!dateLabelPositions(lines[hit.i]).length) {
        for (let back = 1; back <= 2; back++) {
          const idx = hit.i - back;
          if (idx < 0) break;
          const lps = dateLabelPositions(lines[idx]);
          if (lps.length < 2) continue;

          const lineHits = hits.filter((h) => h.i === hit.i && !h.used);
          if (lineHits.length >= 2) {
            lps.forEach((lp, k) => {
              const h = lineHits[k];
              if (h && !out[lp.key]) {
                out[lp.key] = h.d.text;
                h.used = true;
              }
            });
            break;
          }
        }
        if (hit.used) continue;
      }

      // 1) labels on the same line, mapped left→right by column position
      const sameLine = dateLabelPositions(lines[hit.i]);
      if (sameLine.length) {
        let best = null;
        for (const lp of sameLine) {
          if (lp.index <= hit.d.index) best = lp; // nearest label before the date
        }
        if (!best) best = sameLine[0];
        const target = sameLine.find((lp) => lp.key === best.key && !out[lp.key]);
        if (target) {
          out[target.key] = hit.d.text;
          hit.used = true;
        }
        if (hit.used) continue;
        // try any free date field labelled on this line
        const free = sameLine.find((lp) => !out[lp.key]);
        if (free) {
          out[free.key] = hit.d.text;
          hit.used = true;
          continue;
        }
      }

      // 2) label on one of the previous two lines
      for (let back = 1; back <= 2; back++) {
        const idx = hit.i - back;
        if (idx < 0) break;
        const key = dateLabelOf(lines[idx]);
        if (!key) continue;
        if (!out[key]) {
          out[key] = hit.d.text;
          hit.used = true;
        }
        break;
      }
    }

    /* ---- pass 3: leftover dates — oldest is DOB, newest is expiry */
    const uniq = [];
    const seen = new Set();
    for (const hit of hits) {
      if (seen.has(hit.d.iso)) continue;
      seen.add(hit.d.iso);
      uniq.push(hit.d);
    }
    uniq.sort((a, b) => a.iso.localeCompare(b.iso));

    const used = new Set([out.dob, out.issue, out.expiry].filter(Boolean));
    const free = uniq.filter((d) => !used.has(d.text));

    if (free.length) {
      if (!out.dob) {
        out.dob = free[0].text;
        free.shift();
      }
      if (free.length && !out.expiry) {
        out.expiry = free[free.length - 1].text;
        free.pop();
      }
      if (free.length && !out.issue) out.issue = free[0].text;
    }

    /* ---- pass 4: name / father positional fallbacks */
    if (!out.fatherName && out.name) {
      const nameIdx = lines.findIndex((l) => l.includes(out.name));
      for (let j = nameIdx + 1; j < Math.min(lines.length, nameIdx + 5) && nameIdx >= 0; j++) {
        const l = lines[j];
        if (!l || labelOf(l)) continue;
        if (looksLikeName(l) && isLatinOnly(l)) {
          out.fatherName = l;
          break;
        }
      }
    }

    for (const key of ['name', 'fatherName']) {
      if (!out[key]) continue;
      const idx = lines.findIndex((l) => l.includes(out[key]));
      if (idx < 0) continue;
      if (out[key].split(/\s+/).length >= 2) continue;
      const nxt = lines[idx + 1];
      if (nxt && looksLikeName(nxt) && isLatinOnly(nxt) && !labelOf(nxt)) {
        out[key] = `${out[key]} ${nxt}`.replace(/\s+/g, ' ');
      }
    }

    if (!out.name) {
      const cand = lines.find(
        (l, i) =>
          i > 0 &&
          looksLikeName(l) &&
          isLatinOnly(l) &&
          l.split(/\s+/).length >= 2 &&
          l.split(/\s+/).length <= 4 &&
          !labelOf(l)
      );
      if (cand) out.name = cand;
    }

    /* ---- country is printed on almost every card but the label may be lost */
    if (!out.country && /\b(pakistan|پاکستان)\b/i.test(text)) out.country = 'Pakistan';

    /* ---- address often spans the next lines */
    if (out.address && out.address.split(/\s+/).length <= 2) {      const idx = lines.findIndex((l) => l.includes(out.address));
      if (idx >= 0) {
        const extra = [];
        for (let j = idx + 1; j < Math.min(lines.length, idx + 3); j++) {
          const l = lines[j];
          if (!l || labelOf(l) || NOISE.test(l)) break;
          extra.push(l);
        }
        if (extra.length) out.address = `${out.address} ${extra.join(' ')}`.replace(/\s+/g, ' ');
      }
    }

    const order = ORDER.filter((k) => out[k]);
    const labels = {};
    for (const k of ORDER) labels[k] = KEY_LABEL[k];

    return { fields: out, order, labels, found: order.length };
  }

  /** merge cloud fields (primary) with local fields (fallback) */
  function merge(primary, secondary) {
    const a = (primary && primary.fields) || {};
    const b = (secondary && secondary.fields) || {};
    const fields = {};
    const sources = {};
    for (const k of ORDER) {
      const av = a[k] && String(a[k]).trim();
      const bv = b[k] && String(b[k]).trim();
      fields[k] = av || bv || '';
      sources[k] = av ? 'online' : bv ? 'offline' : '';
    }
    const order = ORDER.filter((k) => fields[k]);
    const labels = {};
    for (const k of ORDER) labels[k] = KEY_LABEL[k];
    return { fields, order, labels, sources, found: order.length };
  }

  /** plain text for copy / download */
  function toText(result) {
    if (!result) return '';
    const { fields, order, labels } = result;
    return order.map((k) => `${labels[k]}: ${fields[k]}`).join('\n');
  }

  /** drop boilerplate lines so the raw view is less noisy */
  function cleanRaw(rawText) {
    return String(rawText || '')
      .split('\n')
      .map(cleanLine)
      .filter((l) => l && !NOISE.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { extract, merge, toText, cleanRaw, normDigits, findCnic, findDates, ORDER, KEY_LABEL };
})();
