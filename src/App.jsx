import { useState, useEffect, useCallback, createContext, useContext } from "react";

// ─── FIREBASE CONFIG ──────────────────────────────────────────────────────────
const FB_CONFIG = {
  apiKey: "AIzaSyBlj2KxMr-o7Eq2MlLyns0vHFeXUpwiXCw",
  authDomain: "timesheet-fb5b6.firebaseapp.com",
  projectId: "timesheet-fb5b6",
  storageBucket: "timesheet-fb5b6.firebasestorage.app",
  messagingSenderId: "373654133506",
  appId: "1:373654133506:web:4ddacefdfb92a01f11001b",
};

// ─── FIREBASE REST API HELPERS ────────────────────────────────────────────────
// We use Firebase REST APIs (no npm) so it works as an artifact too
const API = {
  _idToken: null,
  _uid: null,

  // AUTH
  async signIn(email, password) {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_CONFIG.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }) }
    );
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    API._idToken = d.idToken;
    API._uid = d.localId;
    return d;
  },

  async signOut() { API._idToken = null; API._uid = null; },

  async createUser(email, password) {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_CONFIG.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }) }
    );
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d;
  },

  async refreshToken(refreshToken) {
    const r = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FB_CONFIG.apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }) }
    );
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    API._idToken = d.id_token;
    API._uid = d.user_id;
    return d;
  },

  // FIRESTORE
  _fsBase() { return `https://firestore.googleapis.com/v1/projects/${FB_CONFIG.projectId}/databases/(default)/documents`; },
  _headers() { return { "Content-Type": "application/json", "Authorization": `Bearer ${API._idToken}` }; },

  _toValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(API._toValue) } };
    if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k,val]) => [k, API._toValue(val)])) } };
    return { stringValue: String(v) };
  },

  _fromValue(v) {
    if (!v) return null;
    if ("nullValue" in v) return null;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return parseInt(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("stringValue" in v) return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(API._fromValue);
    if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k,val]) => [k, API._fromValue(val)]));
    return null;
  },

  _docToObj(doc) {
    if (!doc || !doc.name) return null;
    const id = doc.name.split("/").pop();
    const data = Object.fromEntries(Object.entries(doc.fields || {}).map(([k,v]) => [k, API._fromValue(v)]));
    return { id, ...data, _path: doc.name };
  },

  async getDoc(collection, id) {
    const r = await fetch(`${API._fsBase()}/${collection}/${id}`, { headers: API._headers() });
    if (r.status === 404) return null;
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return API._docToObj(d);
  },

  async getDocs(collection, filters = []) {
    // Use runQuery for filtered queries
    if (filters.length > 0) {
      const body = {
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: filters.length === 1 ? {
            fieldFilter: {
              field: { fieldPath: filters[0].field },
              op: filters[0].op || "EQUAL",
              value: API._toValue(filters[0].value),
            }
          } : {
            compositeFilter: {
              op: "AND",
              filters: filters.map(f => ({
                fieldFilter: {
                  field: { fieldPath: f.field },
                  op: f.op || "EQUAL",
                  value: API._toValue(f.value),
                }
              }))
            }
          },
          // Note: orderBy with filters requires composite index in Firestore - sort in JS instead
        }
      };
      const r = await fetch(`${API._fsBase().replace("/documents","")}/documents:runQuery`, {
        method: "POST", headers: API._headers(), body: JSON.stringify(body)
      });
      const arr = await r.json();
      if (arr.error) throw new Error(arr.error.message);
      return arr.filter(x => x.document).map(x => API._docToObj(x.document));
    }

    const r = await fetch(`${API._fsBase()}/${collection}?pageSize=500`, { headers: API._headers() });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return (d.documents || []).map(API._docToObj);
  },

  async setDoc(collection, id, data) {
    const fields = Object.fromEntries(Object.entries(data).map(([k,v]) => [k, API._toValue(v)]));
    const r = await fetch(`${API._fsBase()}/${collection}/${id}`, {
      method: "PATCH", headers: API._headers(), body: JSON.stringify({ fields })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return API._docToObj(d);
  },

  async addDoc(collection, data) {
    const fields = Object.fromEntries(Object.entries(data).map(([k,v]) => [k, API._toValue(v)]));
    const r = await fetch(`${API._fsBase()}/${collection}`, {
      method: "POST", headers: API._headers(), body: JSON.stringify({ fields })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return API._docToObj(d);
  },

  async updateDoc(collection, id, data) {
    // PATCH with field mask
    const fields = Object.fromEntries(Object.entries(data).map(([k,v]) => [k, API._toValue(v)]));
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join("&");
    const r = await fetch(`${API._fsBase()}/${collection}/${id}?${mask}`, {
      method: "PATCH", headers: API._headers(), body: JSON.stringify({ fields })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return API._docToObj(d);
  },

  async deleteDoc(collection, id) {
    const r = await fetch(`${API._fsBase()}/${collection}/${id}`, {
      method: "DELETE", headers: API._headers()
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error?.message); }
    return true;
  },

  async queryDocs(collection, orderField = "createdAt", direction = "DESCENDING") {
    const body = {
      structuredQuery: {
        from: [{ collectionId: collection }],
        orderBy: [{ field: { fieldPath: orderField }, direction }],
        limit: 500,
      }
    };
    const r = await fetch(`${API._fsBase().replace("/documents","")}/documents:runQuery`, {
      method: "POST", headers: API._headers(), body: JSON.stringify(body)
    });
    const arr = await r.json();
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => x.document).map(x => API._docToObj(x.document));
  },
};

// ─── CONTEXT ──────────────────────────────────────────────────────────────────
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);

// ─── STYLES ───────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #f5f6fa; --bg2: #ffffff; --bg3: #eef0f6;
  --border: #e2e5ef; --border2: #d0d4e4;
  --text: #374151; --muted: #9ca3af; --bright: #111827;
  --orange: #f97316; --orange-dim: #ea6c0a; --orange-light: #fff7ed; --orange-border: #fed7aa;
  --green: #16a34a; --green-light: #f0fdf4; --green-border: #bbf7d0;
  --red: #dc2626; --red-light: #fef2f2; --red-border: #fecaca;
  --blue: #2563eb; --blue-light: #eff6ff; --blue-border: #bfdbfe;
  --purple: #7c3aed; --purple-light: #f5f3ff; --purple-border: #ddd6fe;
  --sidebar-bg: #1e293b; --sidebar-text: #94a3b8; --sidebar-active: #f97316;
  --r: 10px; --sw: 232px;
  --shadow-sm: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.05);
  --shadow: 0 4px 16px rgba(0,0,0,.08), 0 2px 6px rgba(0,0,0,.04);
  --shadow-lg: 0 20px 48px rgba(0,0,0,.12);
}
html,body { height:100%; background:var(--bg); color:var(--text); font-family:'Plus Jakarta Sans',sans-serif; }

/* Layout */
.layout { display:flex; height:100vh; overflow:hidden; }
.sidebar { width:var(--sw); background:var(--sidebar-bg); display:flex; flex-direction:column; flex-shrink:0; }
.main { flex:1; display:flex; flex-direction:column; overflow:hidden; }
.topbar { height:60px; background:var(--bg2); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 28px; flex-shrink:0; box-shadow:var(--shadow-sm); }
.page { flex:1; overflow-y:auto; padding:28px; background:var(--bg); }

/* Sidebar */
.sb-logo { padding:22px 18px 16px; border-bottom:1px solid rgba(255,255,255,.08); }
.sb-logo h1 { font-size:16px; font-weight:800; color:#fff; letter-spacing:.3px; }
.sb-logo p { font-family:'DM Mono'; font-size:10px; color:var(--orange); letter-spacing:2px; text-transform:uppercase; margin-top:3px; }
.sb-sec { padding:16px 16px 6px; font-family:'DM Mono'; font-size:10px; color:rgba(255,255,255,.3); letter-spacing:1.5px; text-transform:uppercase; }
.sb-nav { padding:4px 10px; display:flex; flex-direction:column; gap:2px; flex:1; }
.sb-btn { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:8px; font-size:13px; font-weight:500; color:var(--sidebar-text); cursor:pointer; border:none; background:none; width:100%; text-align:left; transition:all .15s; }
.sb-btn:hover { background:rgba(255,255,255,.08); color:#fff; }
.sb-btn.active { background:var(--orange); color:#fff; font-weight:700; }
.sb-btn.active svg { stroke:#fff; }
.sb-foot { border-top:1px solid rgba(255,255,255,.08); padding:14px; }
.sb-user { display:flex; align-items:center; gap:10px; }
.ava { width:34px; height:34px; border-radius:50%; background:var(--orange); color:#fff; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-family:'DM Mono'; }
.ava-sm { width:28px; height:28px; font-size:11px; }
.u-name { font-size:13px; font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.u-role { font-family:'DM Mono'; font-size:10px; color:rgba(255,255,255,.4); text-transform:uppercase; letter-spacing:1px; }

/* Buttons */
.btn { display:inline-flex; align-items:center; gap:7px; padding:8px 16px; border-radius:var(--r); font-size:13px; font-weight:600; cursor:pointer; border:none; font-family:'Plus Jakarta Sans'; transition:all .15s; white-space:nowrap; }
.btn-p { background:var(--orange); color:#fff; box-shadow:0 2px 8px rgba(249,115,22,.35); }
.btn-p:hover { background:var(--orange-dim); box-shadow:0 4px 12px rgba(249,115,22,.4); transform:translateY(-1px); }
.btn-s { background:var(--bg2); color:var(--text); border:1px solid var(--border); box-shadow:var(--shadow-sm); }
.btn-s:hover { background:var(--bg3); border-color:var(--border2); }
.btn-d { background:var(--red-light); color:var(--red); border:1px solid var(--red-border); }
.btn-d:hover { background:#fee2e2; }
.btn-g { background:none; color:var(--muted); border:none; padding:6px; border-radius:6px; }
.btn-g:hover { background:var(--bg3); color:var(--text); }
.btn-sm { padding:5px 12px; font-size:12px; }
.btn:disabled { opacity:.5; cursor:not-allowed; transform:none !important; }

/* Cards */
.card { background:var(--bg2); border:1px solid var(--border); border-radius:var(--r); box-shadow:var(--shadow-sm); }
.card-h { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
.card-t { font-size:14px; font-weight:700; color:var(--bright); }

/* Stats */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); gap:14px; margin-bottom:24px; }
.stat { background:var(--bg2); border:1px solid var(--border); border-radius:var(--r); padding:20px; position:relative; overflow:hidden; box-shadow:var(--shadow-sm); }
.stat::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,var(--orange),#fb923c); border-radius:var(--r) var(--r) 0 0; }
.stat-l { font-family:'DM Mono'; font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1.5px; margin-bottom:10px; }
.stat-v { font-size:32px; font-weight:800; color:var(--bright); line-height:1; }
.stat-s { font-size:12px; color:var(--muted); margin-top:4px; }

/* Table */
.tw { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th { padding:11px 16px; text-align:left; font-family:'DM Mono'; font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1.5px; border-bottom:1px solid var(--border); white-space:nowrap; background:var(--bg); }
td { padding:13px 16px; font-size:13px; border-bottom:1px solid var(--border); vertical-align:middle; color:var(--text); }
tr:last-child td { border-bottom:none; }
tr:hover td { background:#fafbff; }

/* Badges */
.bdg { display:inline-flex; align-items:center; padding:3px 10px; border-radius:99px; font-family:'DM Mono'; font-size:10px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; }
.bdg-a { background:var(--orange-light); color:var(--orange); border:1px solid var(--orange-border); }
.bdg-g { background:var(--green-light); color:var(--green); border:1px solid var(--green-border); }
.bdg-b { background:var(--blue-light); color:var(--blue); border:1px solid var(--blue-border); }
.bdg-m { background:var(--bg3); color:var(--muted); border:1px solid var(--border); }

/* Forms */
.fld { display:flex; flex-direction:column; gap:6px; }
.fld label { font-family:'DM Mono'; font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:1.2px; font-weight:500; }
.fld input,.fld select,.fld textarea { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:10px 13px; font-size:13px; color:var(--bright); font-family:'Plus Jakarta Sans'; outline:none; transition:all .15s; width:100%; box-shadow:var(--shadow-sm); }
.fld input:focus,.fld select:focus,.fld textarea:focus { border-color:var(--orange); box-shadow:0 0 0 3px rgba(249,115,22,.12); }
.fld textarea { resize:vertical; }
.r2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }

/* Modal */
.ov { position:fixed; inset:0; background:rgba(15,23,42,.5); backdrop-filter:blur(6px); z-index:200; display:flex; align-items:center; justify-content:center; padding:20px; }
.modal { background:var(--bg2); border:1px solid var(--border); border-radius:16px; width:100%; max-width:480px; box-shadow:var(--shadow-lg); }
.modal-h { padding:22px 24px 0; display:flex; align-items:center; justify-content:space-between; }
.modal-h h3 { font-size:17px; font-weight:700; color:var(--bright); }
.modal-b { padding:20px 24px; display:flex; flex-direction:column; gap:14px; }
.modal-f { padding:0 24px 22px; display:flex; gap:10px; justify-content:flex-end; }

/* Misc */
.row { display:flex; align-items:center; }
.gap4 { gap:4px; } .gap8 { gap:8px; } .gap12 { gap:12px; } .gap16 { gap:16px; }
.mb16 { margin-bottom:16px; } .mt12 { margin-top:12px; }
.ml-a { margin-left:auto; }
.muted { color:var(--muted); font-size:12px; }
.bright { color:var(--bright); font-weight:600; }
.mono { font-family:'DM Mono'; }
.empty { text-align:center; padding:48px 24px; color:var(--muted); font-size:13px; }
.chips { display:flex; flex-wrap:wrap; gap:6px; }
.chip { background:var(--orange-light); border:1px solid var(--orange-border); border-radius:99px; padding:3px 10px; font-size:11px; color:var(--orange); font-weight:600; font-family:'DM Mono'; }
.err { background:var(--red-light); border:1px solid var(--red-border); border-radius:8px; padding:10px 14px; font-size:13px; color:var(--red); }
.ok  { background:var(--green-light); border:1px solid var(--green-border); border-radius:8px; padding:10px 14px; font-size:13px; color:var(--green); }
.divider { height:1px; background:var(--border); margin:8px 0; }

/* Login */
.login-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,#f0f4ff 0%,#fef3ec 100%); }
.login-card { background:var(--bg2); border:1px solid var(--border); border-radius:20px; padding:44px 40px; width:100%; max-width:400px; box-shadow:var(--shadow-lg); position:relative; overflow:hidden; }
.login-card::before { content:''; position:absolute; top:0; left:0; right:0; height:4px; background:linear-gradient(90deg,var(--orange),#fb923c,#fbbf24); }
.login-logo { margin-bottom:32px; }
.login-logo h1 { font-size:26px; font-weight:800; color:var(--bright); }
.login-logo p { font-family:'DM Mono'; font-size:10px; color:var(--orange); text-transform:uppercase; letter-spacing:2px; margin-top:5px; }

/* Spinner */
.spin { display:inline-block; width:14px; height:14px; border:2px solid var(--border2); border-top-color:var(--orange); border-radius:50%; animation:spin .6s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

::-webkit-scrollbar { width:6px; }
::-webkit-scrollbar-thumb { background:var(--border2); border-radius:99px; }
::-webkit-scrollbar-track { background:transparent; }
`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const initials = (n = "") => n.split(" ").map(w => w[0] || "").join("").slice(0, 2).toUpperCase() || "?";
const today = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const fmtDate = d => d ? new Date(d).toLocaleDateString("ro-RO", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const ROLES = { admin: "Administrator", manager: "Manager", pm: "Project Manager" };
const ROLE_BADGE = { admin: "bdg-a", manager: "bdg-b", pm: "bdg-g" };
const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ─── ICONS ────────────────────────────────────────────────────────────────────
const Ic = ({ d, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {(Array.isArray(d) ? d : [d]).map((p, i) => <path key={i} d={p} />)}
  </svg>
);
const I = {
  dash: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  users: ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M23 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  plus: "M12 5v14M5 12h14",
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"],
  edit: ["M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"],
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  eye: ["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  eyeoff: ["M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94", "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19", "M1 1l22 22"],
  report: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8", "M10 9H8"],
};

// ─── SESSION STORAGE ──────────────────────────────────────────────────────────
const SESSION_KEY = "ts_fb_session";
const saveSession = (data) => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch {} };
const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
const clearSession = () => { try { sessionStorage.removeItem(SESSION_KEY); } catch {} };

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function App() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard");

  useEffect(() => {
    const sess = loadSession();
    if (sess?.refreshToken) {
      API.refreshToken(sess.refreshToken)
        .then(() => API.getDoc("users", API._uid))
        .then(p => { if (p) setProfile(p); else clearSession(); })
        .catch(() => clearSession())
        .finally(() => setLoading(false));
    } else setLoading(false);
  }, []);

  const handleLogin = async (refreshToken, uid) => {
    saveSession({ refreshToken, uid });
    const p = await API.getDoc("users", uid);
    setProfile(p);
    setPage(p?.role === "pm" ? "my-ts" : "dashboard");
  };

  const handleLogout = () => {
    API.signOut(); clearSession(); setProfile(null); setPage("dashboard");
  };

  if (loading) return (
    <>
      <style>{CSS}</style>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontFamily: "Sora,sans-serif" }}>
        <div className="spin" style={{ width: 24, height: 24 }} />
      </div>
    </>
  );

  if (!profile) return <LoginPage onLogin={handleLogin} />;

  const isAdmin = profile.role === "admin";
  const isMgr = profile.role === "manager";

  const navAdmin = [
    { k: "dashboard", l: "Dashboard", i: I.dash },
    { k: "projects", l: "Proiecte", i: I.folder },
    { k: "users", l: "Utilizatori", i: I.users },
    { k: "timesheets", l: "Timesheets", i: I.report },
  ];
  const navMgr = [
    { k: "dashboard", l: "Dashboard", i: I.dash },
    { k: "projects", l: "Proiecte", i: I.folder },
    { k: "users", l: "Project Managers", i: I.users },
    { k: "timesheets", l: "Toate timesheeturile", i: I.report },
    { k: "my-ts", l: "Orele mele", i: I.clock },
    { k: "new-ts", l: "Pontează ore", i: I.plus },
  ];
  const navPM = [
    { k: "my-ts", l: "Orele mele", i: I.clock },
    { k: "new-ts", l: "Pontează ore", i: I.plus },
  ];
  const nav = isAdmin ? navAdmin : isMgr ? navMgr : navPM;

  const titles = { dashboard: "Dashboard", projects: "Proiecte", users: "Utilizatori", timesheets: "Timesheets", "my-ts": "Orele Mele", "new-ts": "Pontează Ore" };

  const ctx = { profile, setPage };

  return (
    <>
      <style>{CSS}</style>
      <Ctx.Provider value={ctx}>
        <div className="layout">
          <aside className="sidebar">
            <div className="sb-logo">
              <h1>⚒ TimeTrack</h1>
              <p>Construction</p>
            </div>
            <div className="sb-nav">
              <div className="sb-sec">Navigare</div>
              {nav.map(n => (
                <button key={n.k} className={`sb-btn ${page === n.k ? "active" : ""}`} onClick={() => setPage(n.k)}>
                  <Ic d={n.i} size={15} /> {n.l}
                </button>
              ))}
            </div>
            <div className="sb-foot">
              <div className="sb-user">
                <div className="ava">{initials(profile.fullName)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="u-name">{profile.fullName}</div>
                  <div className="u-role">{ROLES[profile.role]}</div>
                </div>
                <button className="btn btn-g" onClick={handleLogout} title="Logout"><Ic d={I.logout} size={15} /></button>
              </div>
            </div>
          </aside>

          <div className="main">
            <div className="topbar">
              <span style={{ fontSize: 16, fontWeight: 700, color: "var(--bright)" }}>{titles[page]}</span>
              <span className={`bdg ${ROLE_BADGE[profile.role]}`}>{ROLES[profile.role]}</span>
            </div>
            <div className="page">
              {page === "dashboard" && <Dashboard />}
              {page === "projects" && <ProjectsPage />}
              {page === "users" && <UsersPage />}
              {page === "timesheets" && <TimesheetsPage />}
              {page === "my-ts" && <MyTimesheets />}
              {page === "new-ts" && <NewTimesheet onDone={() => setPage("my-ts")} />}
            </div>
          </div>
        </div>
      </Ctx.Provider>
    </>
  );
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!email || !pass) return;
    setLoading(true); setErr("");
    try {
      const d = await API.signIn(email, pass);
      await onLogin(d.refreshToken, d.localId);
    } catch (e) {
      const msg = e.message || "";
      setErr(msg.includes("INVALID_LOGIN") || msg.includes("INVALID_PASSWORD") || msg.includes("EMAIL_NOT_FOUND")
        ? "Email sau parolă incorecte." : msg.includes("TOO_MANY_ATTEMPTS") ? "Prea multe încercări. Încearcă mai târziu." : msg);
    }
    setLoading(false);
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-logo"><h1>⚒ TimeTrack</h1><p>Construction Division</p></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="fld">
              <label>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.ro" onKeyDown={e => e.key === "Enter" && submit()} />
            </div>
            <div className="fld">
              <label>Parolă</label>
              <div style={{ position: "relative" }}>
                <input type={show ? "text" : "password"} value={pass} onChange={e => setPass(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && submit()} style={{ paddingRight: 40 }} />
                <button className="btn btn-g" style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", padding: 5 }} onClick={() => setShow(s => !s)}>
                  <Ic d={show ? I.eyeoff : I.eye} size={14} />
                </button>
              </div>
            </div>
            {err && <div className="err">{err}</div>}
            <button className="btn btn-p" style={{ justifyContent: "center", padding: "11px", marginTop: 4 }} onClick={submit} disabled={loading || !email || !pass}>
              {loading ? <><div className="spin" /> Se autentifică…</> : "Intră în aplicație"}
            </button>
          </div>
          <p style={{ marginTop: 20, fontSize: 11, color: "var(--muted)", textAlign: "center" }}>Sistem intern · Colliers Romania Construction</p>
        </div>
      </div>
    </>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard() {
  const [data, setData] = useState({ projects: [], entries: [], users: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      API.queryDocs("projects", "createdAt"),
      API.queryDocs("timesheets", "workDate", "DESCENDING"),
      API.queryDocs("users", "createdAt"),
    ]).then(([projects, entries, users]) => {
      setData({ projects, entries, users });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthH = data.entries.filter(e => e.workDate?.startsWith(thisMonth)).reduce((s, e) => s + (e.hours || 0), 0);
  const totalH = data.entries.reduce((s, e) => s + (e.hours || 0), 0);
  const activeProjects = data.projects.filter(p => p.status === "active");

  // hours per project
  const byProject = activeProjects.map(p => ({
    ...p,
    hours: data.entries.filter(e => e.projectId === p.id).reduce((s, e) => s + (e.hours || 0), 0),
  })).sort((a, b) => b.hours - a.hours);

  const recent = data.entries.slice(0, 8);

  // enrich recent with names
  const userMap = Object.fromEntries(data.users.map(u => [u.id, u]));
  const projMap = Object.fromEntries(data.projects.map(p => [p.id, p]));

  return (
    <div>
      <div className="stats">
        <div className="stat"><div className="stat-l">Proiecte Active</div><div className="stat-v">{activeProjects.length}</div></div>
        <div className="stat"><div className="stat-l">Utilizatori</div><div className="stat-v">{data.users.length}</div></div>
        <div className="stat"><div className="stat-l">Ore Luna Curentă</div><div className="stat-v">{monthH.toFixed(1)}<span style={{ fontSize: 14, color: "var(--muted)" }}>h</span></div></div>
        <div className="stat"><div className="stat-l">Total Ore Logat</div><div className="stat-v">{totalH.toFixed(1)}<span style={{ fontSize: 14, color: "var(--muted)" }}>h</span></div></div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="card">
          <div className="card-h"><span className="card-t">Ore pe Proiect</span></div>
          <div className="tw">
            <table>
              <thead><tr><th>Proiect</th><th>Cod</th><th>Total</th></tr></thead>
              <tbody>
                {byProject.length === 0 && <tr><td colSpan={3}><div className="empty">Niciun proiect.</div></td></tr>}
                {byProject.map(p => (
                  <tr key={p.id}>
                    <td className="bright">{p.name}</td>
                    <td><span className="bdg bdg-a mono">{p.code}</span></td>
                    <td style={{ color: "var(--amber)", fontWeight: 700, fontFamily: "DM Mono" }}>{p.hours.toFixed(1)}h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><span className="card-t">Activitate Recentă</span></div>
          {recent.length === 0
            ? <div className="empty">Nicio activitate.</div>
            : <div style={{ padding: "8px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
              {recent.map(e => {
                const u = userMap[e.userId]; const p = projMap[e.projectId];
                return (
                  <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ fontFamily: "DM Mono", fontSize: 18, fontWeight: 700, color: "var(--amber)", width: 40, flexShrink: 0 }}>{e.hours}h</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bright)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p?.name || "—"}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{u?.fullName || "—"} · {e.workDate}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          }
        </div>
      </div>
    </div>
  );
}

// ─── PROJECTS ─────────────────────────────────────────────────────────────────
function ProjectsPage() {
  const { profile } = useApp();
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [form, setForm] = useState({ name: "", code: "", description: "", status: "active" });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [p, u] = await Promise.all([
      API.queryDocs("projects", "createdAt"),
      API.queryDocs("users", "fullName"),
    ]);
    setProjects(p); setUsers(u);
  }, []);

  useEffect(() => { load(); }, []);

  const openNew = () => { setForm({ name: "", code: "", description: "", status: "active" }); setModal("new"); setErr(""); };
  const openEdit = (p) => { setForm({ name: p.name, code: p.code, description: p.description || "", status: p.status }); setModal(p); setErr(""); };

  const save = async () => {
    if (!form.name.trim() || !form.code.trim()) { setErr("Numele și codul sunt obligatorii."); return; }
    setLoading(true); setErr("");
    try {
      if (modal === "new") {
        const id = genId();
        await API.setDoc("projects", id, { ...form, code: form.code.toUpperCase(), createdAt: nowISO(), createdBy: profile.id, assignedUsers: [] });
      } else {
        await API.updateDoc("projects", modal.id, { name: form.name, code: form.code.toUpperCase(), description: form.description, status: form.status });
      }
      setModal(null); load();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  const del = async (p) => {
    if (!confirm(`Ștergi proiectul "${p.name}"?`)) return;
    await API.deleteDoc("projects", p.id); load();
  };

  const canEdit = profile.role === "admin" || profile.role === "manager";

  return (
    <div>
      <div className="row mb16" style={{ justifyContent: "flex-end" }}>
        {profile.role === "admin" && <button className="btn btn-p" onClick={openNew}><Ic d={I.plus} size={14} /> Proiect Nou</button>}
      </div>
      <div className="card">
        <div className="tw">
          <table>
            <thead><tr><th>Proiect</th><th>Cod</th><th>Status</th><th>Project Managers</th><th></th></tr></thead>
            <tbody>
              {projects.length === 0 && <tr><td colSpan={5}><div className="empty">Niciun proiect creat încă.</div></td></tr>}
              {projects.map(p => {
                const assigned = (p.assignedUsers || []).map(uid => users.find(u => u.id === uid)).filter(Boolean);
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="bright">{p.name}</div>
                      {p.description && <div className="muted" style={{ marginTop: 3 }}>{p.description}</div>}
                    </td>
                    <td><span className="bdg bdg-a mono">{p.code}</span></td>
                    <td><span className={`bdg ${p.status === "active" ? "bdg-g" : p.status === "completed" ? "bdg-b" : "bdg-m"}`}>{p.status}</span></td>
                    <td>
                      <div className="chips">
                        {assigned.length === 0
                          ? <span className="muted">—</span>
                          : assigned.map(u => <span key={u.id} className="chip">{u.fullName?.split(" ")[0]}</span>)}
                      </div>
                    </td>
                    <td>
                      {canEdit && (
                        <div className="row gap8" style={{ justifyContent: "flex-end" }}>
                          <button className="btn btn-s btn-sm" onClick={() => setAssignModal(p)}><Ic d={I.users} size={13} /> Alocă</button>
                          {profile.role === "admin" && <>
                            <button className="btn btn-g" onClick={() => openEdit(p)}><Ic d={I.edit} size={14} /></button>
                            <button className="btn btn-g" style={{ color: "var(--red)" }} onClick={() => del(p)}><Ic d={I.trash} size={14} /></button>
                          </>}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <div className="ov" onClick={e => e.target === e.currentTarget && setModal(null)}>
          <div className="modal">
            <div className="modal-h"><h3>{modal === "new" ? "Proiect Nou" : "Editează Proiect"}</h3><button className="btn btn-g" onClick={() => setModal(null)}><Ic d={I.x} size={16} /></button></div>
            <div className="modal-b">
              {err && <div className="err">{err}</div>}
              <div className="r2">
                <div className="fld"><label>Nume proiect *</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="ex. Centrul Civic Tower" /></div>
                <div className="fld"><label>Cod *</label><input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="CCT-01" /></div>
              </div>
              <div className="fld"><label>Descriere</label><textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} placeholder="Detalii…" /></div>
              <div className="fld"><label>Status</label>
                <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="active">Active</option><option value="inactive">Inactive</option><option value="completed">Completed</option>
                </select>
              </div>
            </div>
            <div className="modal-f">
              <button className="btn btn-s" onClick={() => setModal(null)}>Anulează</button>
              <button className="btn btn-p" onClick={save} disabled={loading}>{loading ? <><div className="spin" /> Se salvează…</> : <><Ic d={I.check} size={14} /> Salvează</>}</button>
            </div>
          </div>
        </div>
      )}

      {assignModal && <AssignModal project={assignModal} users={users} onClose={() => { setAssignModal(null); load(); }} />}
    </div>
  );
}

function AssignModal({ project, users, onClose }) {
  const { profile } = useApp();
  const eligible = users.filter(u => u.role === "pm" || u.role === "manager");
  const [assigned, setAssigned] = useState(project.assignedUsers || []);
  const [loading, setLoading] = useState(false);

  const toggle = async (uid) => {
    setLoading(true);
    const next = assigned.includes(uid) ? assigned.filter(x => x !== uid) : [...assigned, uid];
    await API.updateDoc("projects", project.id, { assignedUsers: next });
    setAssigned(next);
    setLoading(false);
  };

  return (
    <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-h"><h3>Alocă PM — {project.name}</h3><button className="btn btn-g" onClick={onClose}><Ic d={I.x} size={16} /></button></div>
        <div className="modal-b">
          {eligible.length === 0
            ? <p className="muted">Nu există project manageri în sistem.</p>
            : eligible.map(u => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--bg3)", borderRadius: 6 }}>
                <div className="row gap8">
                  <div className="ava ava-sm">{initials(u.fullName)}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bright)" }}>{u.fullName}</div>
                    <div className="muted">{ROLES[u.role]}</div>
                  </div>
                </div>
                <button className={`btn btn-sm ${assigned.includes(u.id) ? "btn-d" : "btn-p"}`} onClick={() => toggle(u.id)} disabled={loading}>
                  {assigned.includes(u.id) ? "Elimină" : "Alocă"}
                </button>
              </div>
            ))
          }
        </div>
        <div className="modal-f"><button className="btn btn-s" onClick={onClose}>Închide</button></div>
      </div>
    </div>
  );
}

// ─── USERS ────────────────────────────────────────────────────────────────────
function UsersPage() {
  const { profile } = useApp();
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ fullName: "", email: "", password: "", role: "pm" });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(""); const [succ, setSucc] = useState("");

  const roleOpts = profile.role === "admin"
    ? [{ v: "pm", l: "Project Manager" }, { v: "manager", l: "Manager" }, { v: "admin", l: "Administrator" }]
    : [{ v: "pm", l: "Project Manager" }];

  const load = useCallback(async () => {
    const u = await API.queryDocs("users", "createdAt");
    setUsers(u);
  }, []);

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!form.fullName.trim() || !form.email.trim() || !form.password.trim()) { setErr("Toate câmpurile sunt obligatorii."); return; }
    if (form.password.length < 6) { setErr("Parola trebuie să aibă minim 6 caractere."); return; }
    setLoading(true); setErr(""); setSucc("");
    try {
      // Create auth user
      const d = await API.createUser(form.email, form.password);
      // Create profile in Firestore
      await API.setDoc("users", d.localId, {
        fullName: form.fullName,
        email: form.email,
        role: form.role,
        createdAt: nowISO(),
        createdBy: profile.id,
      });
      setSucc(`Contul pentru ${form.fullName} a fost creat cu succes!`);
      setForm({ fullName: "", email: "", password: "", role: "pm" });
      load();
      setTimeout(() => { setModal(false); setSucc(""); }, 2000);
    } catch (e) {
      const msg = e.message || "";
      setErr(msg.includes("EMAIL_EXISTS") ? "Există deja un cont cu acest email." : msg);
    }
    setLoading(false);
  };

  const del = async (u) => {
    if (!confirm(`Ștergi utilizatorul "${u.fullName}"?`)) return;
    await API.deleteDoc("users", u.id);
    load();
  };

  return (
    <div>
      <div className="row mb16" style={{ justifyContent: "flex-end" }}>
        <button className="btn btn-p" onClick={() => { setModal(true); setErr(""); setSucc(""); }}><Ic d={I.plus} size={14} /> Utilizator Nou</button>
      </div>
      <div className="card">
        <div className="tw">
          <table>
            <thead><tr><th>Utilizator</th><th>Email</th><th>Rol</th><th>Creat</th><th></th></tr></thead>
            <tbody>
              {users.length === 0 && <tr><td colSpan={5}><div className="empty">Niciun utilizator.</div></td></tr>}
              {users.map(u => (
                <tr key={u.id}>
                  <td><div className="row gap8"><div className="ava ava-sm">{initials(u.fullName)}</div><span className="bright">{u.fullName}</span></div></td>
                  <td><span className="muted mono" style={{ fontSize: 12 }}>{u.email}</span></td>
                  <td><span className={`bdg ${ROLE_BADGE[u.role]}`}>{ROLES[u.role]}</span></td>
                  <td className="muted">{fmtDate(u.createdAt)}</td>
                  <td>
                    {profile.role === "admin" && u.id !== profile.id && (
                      <button className="btn btn-g" style={{ color: "var(--red)" }} onClick={() => del(u)}><Ic d={I.trash} size={14} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <div className="ov" onClick={e => e.target === e.currentTarget && setModal(false)}>
          <div className="modal">
            <div className="modal-h"><h3>Utilizator Nou</h3><button className="btn btn-g" onClick={() => setModal(false)}><Ic d={I.x} size={16} /></button></div>
            <div className="modal-b">
              {err && <div className="err">{err}</div>}
              {succ && <div className="ok">{succ}</div>}
              <div className="fld"><label>Nume Complet *</label><input value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} placeholder="Alexandru Ionescu" /></div>
              <div className="r2">
                <div className="fld"><label>Email *</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="a.ionescu@company.ro" /></div>
                <div className="fld"><label>Parolă *</label><input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="minim 6 caractere" /></div>
              </div>
              <div className="fld"><label>Rol</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  {roleOpts.map(r => <option key={r.v} value={r.v}>{r.l}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-f">
              <button className="btn btn-s" onClick={() => setModal(false)}>Anulează</button>
              <button className="btn btn-p" onClick={save} disabled={loading || !!succ}>
                {loading ? <><div className="spin" /> Se creează…</> : <><Ic d={I.check} size={14} /> Creează Cont</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TIMESHEETS (admin/manager view) ─────────────────────────────────────────
function TimesheetsPage() {
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState({ project: "", user: "", month: "" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      API.queryDocs("timesheets", "workDate", "DESCENDING"),
      API.queryDocs("projects", "createdAt"),
      API.queryDocs("users", "fullName"),
    ]).then(([e, p, u]) => { setEntries(e); setProjects(p); setUsers(u); setLoading(false); });
  }, []);

  const del = async (id) => {
    if (!confirm("Ștergi înregistrarea?")) return;
    await API.deleteDoc("timesheets", id);
    setEntries(ev => ev.filter(e => e.id !== id));
  };

  const filtered = entries.filter(e => {
    if (filter.project && e.projectId !== filter.project) return false;
    if (filter.user && e.userId !== filter.user) return false;
    if (filter.month && !e.workDate?.startsWith(filter.month)) return false;
    return true;
  });
  const total = filtered.reduce((s, e) => s + (e.hours || 0), 0);

  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  return (
    <div>
      <div className="row gap12 mb16" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="fld" style={{ minWidth: 180 }}>
          <label>Proiect</label>
          <select value={filter.project} onChange={e => setFilter(f => ({ ...f, project: e.target.value }))}>
            <option value="">Toate</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="fld" style={{ minWidth: 180 }}>
          <label>Utilizator</label>
          <select value={filter.user} onChange={e => setFilter(f => ({ ...f, user: e.target.value }))}>
            <option value="">Toți</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </select>
        </div>
        <div className="fld" style={{ minWidth: 140 }}>
          <label>Lună</label>
          <input type="month" value={filter.month} onChange={e => setFilter(f => ({ ...f, month: e.target.value }))} />
        </div>
        <div style={{ fontFamily: "DM Mono", fontSize: 18, fontWeight: 700, color: "var(--amber)", paddingBottom: 2 }}>
          Total: {total.toFixed(1)}h
        </div>
      </div>
      <div className="card">
        <div className="tw">
          <table>
            <thead><tr><th>Data</th><th>Utilizator</th><th>Proiect</th><th>Ore</th><th>Notă</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6}><div className="empty"><div className="spin" style={{ width: 20, height: 20 }} /></div></td></tr>}
              {!loading && filtered.length === 0 && <tr><td colSpan={6}><div className="empty">Nicio înregistrare.</div></td></tr>}
              {filtered.map(e => {
                const u = userMap[e.userId]; const p = projMap[e.projectId];
                return (
                  <tr key={e.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{e.workDate}</td>
                    <td><div className="row gap8"><div className="ava ava-sm">{initials(u?.fullName)}</div><span className="bright">{u?.fullName || "—"}</span></div></td>
                    <td><span className="bdg bdg-a mono">{p?.code}</span> <span style={{ fontSize: 13 }}>{p?.name}</span></td>
                    <td><span style={{ fontFamily: "DM Mono", fontSize: 20, fontWeight: 700, color: "var(--amber)" }}>{e.hours}</span><span className="muted">h</span></td>
                    <td style={{ color: "var(--muted)", fontStyle: "italic", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.note || "—"}</td>
                    <td><button className="btn btn-g" style={{ color: "var(--red)" }} onClick={() => del(e.id)}><Ic d={I.trash} size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── MY TIMESHEETS ────────────────────────────────────────────────────────────
function MyTimesheets() {
  const { profile } = useApp();
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      API.queryDocs("timesheets", "createdAt", "DESCENDING"),
      API.queryDocs("projects", "name"),
    ]).then(([all, p]) => {
      // Filter in JS — no Firestore composite index needed
      const mine = (all || [])
        .filter(e => e.userId === profile.id)
        .sort((a, b) => (b.workDate || "").localeCompare(a.workDate || ""));
      setEntries(mine); setProjects(p); setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const del = async (id) => {
    if (!confirm("Ștergi înregistrarea?")) return;
    await API.deleteDoc("timesheets", id);
    setEntries(ev => ev.filter(e => e.id !== id));
  };

  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthH = entries.filter(e => e.workDate?.startsWith(thisMonth)).reduce((s, e) => s + (e.hours || 0), 0);
  const totalH = entries.reduce((s, e) => s + (e.hours || 0), 0);
  const projMap = Object.fromEntries(projects.map(p => [p.id, p]));

  return (
    <div>
      <div className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)", maxWidth: 520 }}>
        <div className="stat"><div className="stat-l">Luna curentă</div><div className="stat-v">{monthH.toFixed(1)}<span style={{ fontSize: 14, color: "var(--muted)" }}>h</span></div></div>
        <div className="stat"><div className="stat-l">Total ore</div><div className="stat-v">{totalH.toFixed(1)}<span style={{ fontSize: 14, color: "var(--muted)" }}>h</span></div></div>
        <div className="stat"><div className="stat-l">Înregistrări</div><div className="stat-v">{entries.length}</div></div>
      </div>
      <div className="card">
        <div className="tw">
          <table>
            <thead><tr><th>Data</th><th>Proiect</th><th>Ore</th><th>Notă</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5}><div className="empty"><div className="spin" style={{ width: 20, height: 20 }} /></div></td></tr>}
              {!loading && entries.length === 0 && <tr><td colSpan={5}><div className="empty">Nu ai ore înregistrate. Folosește "Pontează ore".</div></td></tr>}
              {entries.map(e => {
                const p = projMap[e.projectId];
                return (
                  <tr key={e.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{e.workDate}</td>
                    <td><span className="bdg bdg-a mono">{p?.code}</span> <span className="bright">{p?.name || "—"}</span></td>
                    <td><span style={{ fontFamily: "DM Mono", fontSize: 20, fontWeight: 700, color: "var(--amber)" }}>{e.hours}</span><span className="muted">h</span></td>
                    <td style={{ color: "var(--muted)", fontStyle: "italic" }}>{e.note || "—"}</td>
                    <td><button className="btn btn-g" style={{ color: "var(--red)" }} onClick={() => del(e.id)}><Ic d={I.trash} size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── NEW TIMESHEET ────────────────────────────────────────────────────────────
function NewTimesheet({ onDone }) {
  const { profile } = useApp();
  const [myProjects, setMyProjects] = useState([]);
  const [form, setForm] = useState({ projectId: "", workDate: today(), hours: "", note: "" });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(""); const [succ, setSucc] = useState(false);

  useEffect(() => {
    API.queryDocs("projects", "name").then(all => {
      const mine = all.filter(p => p.status === "active" && (p.assignedUsers || []).includes(profile.id));
      setMyProjects(mine);
    });
  }, []);

  const submit = async () => {
    if (!form.projectId || !form.workDate || !form.hours) { setErr("Toate câmpurile marcate sunt obligatorii."); return; }
    const h = parseFloat(form.hours);
    if (isNaN(h) || h <= 0 || h > 24) { setErr("Orele trebuie să fie între 0.5 și 24."); return; }
    setLoading(true); setErr("");
    try {
      const id = genId();
      await API.setDoc("timesheets", id, {
        projectId: form.projectId, userId: profile.id,
        workDate: form.workDate, hours: h,
        note: form.note || "", createdAt: nowISO(),
      });
      setSucc(true);
      setTimeout(() => { setSucc(false); setForm({ projectId: "", workDate: today(), hours: "", note: "" }); onDone(); }, 1400);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 480 }}>
      <div className="card">
        <div className="card-h"><span className="card-t">Înregistrare Ore</span></div>
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
          {myProjects.length === 0
            ? <div className="empty" style={{ padding: "32px 0" }}>
              <Ic d={I.folder} size={36} />
              <p style={{ marginTop: 12 }}>Nu ești alocat la niciun proiect activ.<br />Contactează managerul tău.</p>
            </div>
            : <>
              {err && <div className="err">{err}</div>}
              {succ && <div className="ok"><Ic d={I.check} size={14} /> Orele au fost salvate!</div>}
              <div className="fld">
                <label>Proiect *</label>
                <select value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}>
                  <option value="">— Selectează —</option>
                  {myProjects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                </select>
              </div>
              <div className="r2">
                <div className="fld"><label>Data *</label><input type="date" value={form.workDate} onChange={e => setForm(f => ({ ...f, workDate: e.target.value }))} /></div>
                <div className="fld"><label>Ore lucrate *</label><input type="number" min="0.5" max="24" step="0.5" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} placeholder="ex. 8" /></div>
              </div>
              <div className="fld"><label>Notă (opțional)</label><textarea value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} rows={3} placeholder="Activitate desfășurată…" /></div>
              <div className="row gap8" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-s" onClick={onDone}>Anulează</button>
                <button className="btn btn-p" onClick={submit} disabled={loading || succ}>
                  {succ ? <><Ic d={I.check} size={14} /> Salvat!</> : loading ? <><div className="spin" /> Se salvează…</> : <><Ic d={I.plus} size={14} /> Salvează orele</>}
                </button>
              </div>
            </>
          }
        </div>
      </div>
    </div>
  );
}
