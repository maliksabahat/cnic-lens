# Clip → Text — card fields, OCR + Urdu→English translation

Chrome ka **"Search this tab with Google Lens"** side panel Gemini nahi kholta, aur
`blob:` URLs address bar me paste karne se bhi kuch nahi khulta. Ye extension wohi
kaam apne side panel me karta hai:

1. WhatsApp (Windows app ya Web) se image copy karo
2. Panel me paste karo → **OCR** (Urdu + English)
3. Card ho to seedha **fields** (Name, Father Name, CNIC, DOB, Issue, Expiry, Address)
4. Ek click par **English translation**
5. Copy / download / image naye tab me

Do modes hain — **Offline** (sab kuch computer par) aur **Online** (free API key se,
tez aur Urdu Nastaliq me behtar).

---

## Do modes

| | Offline | Online ⚡ |
| --- | --- | --- |
| Internet | zaroorat nahi | chahiye |
| Setup | kuch nahi | free API key (1 minute) |
| Scanning | Tesseract 5 (bundled) | Gemini / OCR.space |
| Urdu Nastaliq cards | kamzor | Gemini se acha |
| Translation | opus-mt-ur-en (bundled) | Google Translate, phir offline fallback |
| Speed | OCR 2–6 s, translate 6–12 s | OCR 2–5 s, translate instant |
| Privacy | image kabhi upload nahi hoti | image cloud API par jati hai |

Mode panel ke top par **Offline | Online** switch se badalta hai. Online fail ho jaye
(quota, internet) to panel khud **offline OCR** chala deta hai — dead end nahi.

---

## Install (ek hi baar)

1. `chrome://extensions` kholo
2. Top-right **Developer mode** ON karo
3. **Load unpacked** → ye folder chuno:
   `C:\Users\MALIK\Documents\Default Project\image-clip-viewer`

> Folder ~176 MB hai (bundled translation model). Ye sirf disk par hai; RAM me sirf
> zaroorat par load hota hai. Online mode me translation model load hi nahi hota.

Update ke baad `chrome://extensions` par **Reload (🔄)** dabana zaroori hai.

### GitHub se install (naye computer par)

Repo me sirf code hai — bhaari offline assets (Tesseract core, urd/eng data,
opus-mt-ur-en model) ek release zip me hain, taake clone halka rahe:

```powershell
git clone https://github.com/maliksabahat/cnic-lens.git
cd cnic-lens
powershell -ExecutionPolicy Bypass -File setup\fetch-vendor.ps1
```

Linux/macOS: `bash setup/fetch-vendor.sh`

Phir `chrome://extensions` → **Load unpacked** → `cnic-lens` folder.

> `test data/` aur `vendor/` git me nahi hain (`.gitignore`) — pehle me aap ke
> asli CNIC scans hain, doosre me 176 MB binaries.

## Online setup (optional, 1 minute)

**Gemini (recommended — Urdu Nastaliq bhi padhta hai):**

1. <https://aistudio.google.com/apikey> kholo
2. **Create API key** dabao (free tier, card nahi chahiye)
3. Key copy karo
4. Panel me **⚙** → Provider `Gemini` → key paste → **Save**
5. Mode **Online ⚡** kar do

**OCR.space (sirf English/mix cards):**

1. <https://ocr.space/ocrapi/freekey> se free key lo (25,000/month)
2. **⚙** → Provider `OCR.space` → key paste → **Save`

Key sirf aap ke Chrome ke local storage me rehti hai; kahin bheji nahi jati.

## Use

1. **`Alt+Shift+V`** dabao (ya toolbar icon) — side panel khul jayega
2. WhatsApp me image par **right-click → Copy image**
3. Panel me **Ctrl+V** dabao (ya "Clipboard" button)
4. OCR khud chalta hai:
   - **Fields** tab — `Name : Alamdar Hussain` style; **kisi bhi line par click karo → value copy**
   - **Raw** tab — poora OCR text
5. **"English me translate karo"** → **English** tab
6. **Copy fields** / **Form bhar do** / ⤓ (text file) / ⤢ (image naye tab me)

Script select: `Urdu + English` (default), `Urdu only`, `English only`.

### Fields kaise nikalte hain

OCR text ko labels ke hisaab se parse kiya jata hai (English + Urdu dono):

```
Name · Father Name · CNIC · Date of Birth · Date of Issue · Date of Expiry · Gender · Country · Address
```

Boilerplate (`ISLAMIC REPUBLIC OF PAKISTAN`, `Holder's Signature`, `Registrar General
of Pakistan`, …) hata diya jata hai. Do-column card (`Date of Issue   Date of Expiry`)
aur ulta (180°) back side bhi handle hota hai. Jo field na mile wo khali rehta hai —
galat guess nahi karta.

Har field ke right side **badge** batata hai ke value kahan se aayi:

- `online` (neela) — cloud OCR/AI (Gemini / OCR.space) se
- `offline` (grey) — local Tesseract + local parser se

Online fail ho kar offline fallback chale to sab badges `offline` ho jate hain — yani
us run me kuch bhi internet se nahi aaya. Neeche meta line bhi count dikhati hai:
`8 fields · 5 online, 3 offline`.

### PM Youth form auto-fill

[Junior Prime Minister's Youth Loan form](https://pmybals.pmyp.gov.pk/BankForm/newApplicantForm)
khula ho, OCR ho jaye, phir **"Form bhar do"** dabao. Ye khud bhar deta hai:

| Field | Kaun sa input |
| --- | --- |
| Name | `ApplicantName` |
| Father / Husband Name | `F_H_Name` |
| CNIC | `CNIC` |
| Date of Birth | `DateOfBirth` (dd-mm-yyyy) |
| Date of Issue | `CnicIssueDate` (dd-mm-yyyy) |
| Gender | `Gender_Id` dropdown |
| Present Address | `Present_Adress` |

Baaki (mobile, income, bank, business, documents) aap khud bharte ho — wo CNIC par
nahi hota. Address back side se aata hai, is liye front + back dono wali image dena
behtar hai.

> Local saved HTML (`file:///…/Youth Programme.html`) par fill karne ke liye Chrome me
> `chrome://extensions` → extension → **"Allow access to file URLs"** ON karna hoga.

---

## Andar kya hai

| Cheez | Engine | Size |
| --- | --- | --- |
| OCR (offline) | Tesseract.js 5 + `urd` / `eng` traineddata | ~7 MB |
| Translation (offline) | opus-mt-ur-en (Marian, int8) via onnxruntime-web | ~140 MB |
| Fields | `fields.js` (labels + dates + CNIC regex) | ~10 KB |
| Online | Gemini API / OCR.space + Google Translate | — |
| UI | vanilla JS, side panel | — |

## Speed (i5 class laptop)

- Offline OCR: 2–6 s (300–400 DPI scan, front + back)
- Offline translation: pehli ~25 s (model load), phir 6–12 s per sentence
- Online OCR: 2–5 s · online translation: instant

## Limits (honest list)

- **Offline mode me purani full-Urdu (Nastaliq) cards** par Tesseract kamzor hai —
  text detect hi nahi hota. Aise cards ke liye **Online + Gemini** use karo
- **Handwriting / dhundli photo** par OCR kamzor hota hai — clear scan best hai
- **Roman Urdu** (e.g. "mujhe kal jana hai") ke liye offline translation model nahi hai;
  panel warning deta hai. Online mode me Google Translate ise bhi translate karta hai
- Offline OCR me chhote spelling errors aa sakte hain — Raw tab me text editable hai
- Online mode me image cloud par jati hai; API quota khatam ho to offline fallback
  chalta hai (status me dikh jata hai)

## Files

| File | Kaam |
| --- | --- |
| `manifest.json` | MV3 config, side panel, permissions, CSP, host permissions |
| `background.js` | Side panel kholna, shortcut, WhatsApp Web blob relay |
| `sidepanel.html/.css/.js` | Poora UI + modes + flow |
| `ocr.js` | Tesseract wrapper: band detection, contrast, 180° retry |
| `fields.js` | Card fields extraction (labels, dates, CNIC, address) |
| `online.js` | Gemini / OCR.space OCR + Google Translate (fallbacks) |
| `translate.js` | opus-mt-ur-en wrapper (offline, local model) |
| `viewer.html/.js/.css` | Image ko poore tab me kholne ke liye |
| `vendor/` | OCR engine, language models, MT model, ONNX runtime |
| `icon*.png` | Toolbar icons |

## Troubleshooting

| Masla | Hal |
| --- | --- |
| "Clipboard read block hui" | Panel par ek click karo, phir "Clipboard" button |
| OCR kuch nahi nikala | Image crop/zoom karke dobara; script `Urdu only` ya Online mode try karo |
| Online: "API key ghalat" | ⚙ me key dobara paste karo (poori key, bina space) |
| Online: "free quota khatam" | Thori der baad try karo, ya apni OCR.space/Gemini key laga do |
| Fields khali | Raw tab dekho; card ka text saaf nahi mila — Online+Gemini best hai |
| "Form bhar do" kaam nahi kiya | Form ka tab active ho; local file ho to "Allow access to file URLs" ON karo |
| Field click par copy nahi hua | Panel par ek click karo (focus), phir field par click |
| Translation fail | `vendor/mt/opus-mt-ur-en/onnx/` me `encoder_model_quantized.onnx` + `decoder_model_merged_quantized.onnx` honi chahiye, saath vocabs/spm files |
| Hotkey kaam nahi | `chrome://extensions/shortcuts` se set karo, ya toolbar icon |
| Panel nahi khulta | Chrome 120+ chahiye |

## Permissions kyun

- `sidePanel` — side panel UI
- `clipboardRead` / `clipboardWrite` — image paste + field click par copy
- `scripting` + `https://web.whatsapp.com/*` — `blob:` URL wali image usi tab se laane ke liye
- `storage` — settings, mode, aur image ko naye tab me bhejna
- `https://generativelanguage.googleapis.com/*`, `https://api.ocr.space/*`,
  `https://translate.googleapis.com/*` — sirf **Online mode** ke liye; Offline mode
  inhe kabhi call nahi karta
- `https://pmybals.pmyp.gov.pk/*` — "Form bhar do" button ke liye (sirf jab aap dabao)
- `file:///*` — local saved form par test karne ke liye; Chrome me "Allow access to
  file URLs" ON karna parta hai

## Credits / licenses

| Cheez | Kahan se | License |
| --- | --- | --- |
| Tesseract.js + tesseract-core | <https://github.com/naptha/tesseract.js> | Apache-2.0 |
| \urd\ / \eng\ traineddata | <https://github.com/tesseract-ocr/tessdata_best> | Apache-2.0 |
| transformers.js | <https://github.com/xenova/transformers.js> | Apache-2.0 |
| onnxruntime-web | <https://github.com/microsoft/onnxruntime> | MIT |
| opus-mt-ur-en (Marian, int8 ONNX) | <https://huggingface.co/Helsinki-NLP/opus-mt-ur-en> | CC-BY-4.0 |
| Icons | is repo ke saath | MIT |

Ye extension Chrome ke Lens/Gemini panel ka replacement hai, Google ka official
product nahi. Card data aap ke device par rehta hai; **Online mode** me image
Gemini/OCR.space ko jati hai — jo bhi aap khud choose karein.
