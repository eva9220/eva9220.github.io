// 初晴之森共用雲端層：Google 登入 + 成員名單權限 + Firestore 資料
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, deleteDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyCar-w8B5h769FfIczVbQeQTosws9kyR8A",
  authDomain: "sunny-forest.firebaseapp.com",
  projectId: "sunny-forest",
  storageBucket: "sunny-forest.firebasestorage.app",
  messagingSenderId: "981586744223",
  appId: "1:981586744223:web:97e0ddd869f1e36e1123aa"
});
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

let started = false;

function panel() {
  let el = document.getElementById("sf-gate");
  if (!el) {
    el = document.createElement("div");
    el.id = "sf-gate";
    el.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fbf6ef;color:#4d4a47;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;font:16px/1.7 'Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif";
    document.body.appendChild(el);
  }
  el.replaceChildren();
  el.style.display = "flex";
  return el;
}
function hidePanel() {
  const el = document.getElementById("sf-gate");
  if (el) el.style.display = "none";
}
function line(text, strong) {
  const p = document.createElement("p");
  p.style.margin = "6px 0";
  if (strong) { p.style.fontSize = "20px"; p.style.fontWeight = "700"; }
  p.textContent = text;
  return p;
}
function button(text, fn) {
  const b = document.createElement("button");
  b.textContent = text;
  b.style.cssText = "margin-top:18px;border:0;border-radius:999px;padding:12px 26px;font:inherit;font-size:16px;background:#86ab98;color:#fff;cursor:pointer";
  b.onclick = fn;
  return b;
}
async function login() {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      return signInWithRedirect(auth, provider);
    }
    alert("登入失敗：" + (e.message || e.code));
  }
}
function showLogin() {
  const el = panel();
  el.append(
    line((document.title.split("｜")[0] || "初晴之森"), true),
    line("請使用 Google 帳號登入。"),
    line("只有管理者加入名單的成員能使用。"),
    button("使用 Google 登入", login)
  );
}
function showDenied(email) {
  const el = panel();
  el.append(
    line("尚未開通使用權限", true),
    line("帳號 " + (email || "（無）") + " 不在成員名單內。"),
    line("請聯絡管理者加入名單，或換一個帳號登入。"),
    button("換一個帳號", () => signOut(auth))
  );
}

// 只有名單內（members 集合裡有該信箱）的人才會進入頁面
function gate(onAllowed) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return showLogin();
    const email = (user.email || "").toLowerCase();
    let role = null;
    try {
      const m = await getDoc(doc(db, "members", email));
      if (m.exists()) role = m.data().role || "staff";
    } catch (e) {
      role = null;
    }
    if (!role) return showDenied(email);
    hidePanel();
    if (!started) {
      started = true;
      onAllowed({ email, role, admin: role === "admin" });
    }
  });
}

const safe = (p) => p.catch((e) => {
  console.error(e);
  alert("儲存失敗，請確認網路連線，或聯絡管理者確認您的權限");
});
const onErr = (e) => console.error(e);

export const SF = {
  gate,
  watch(name, cb) {
    return onSnapshot(collection(db, name),
      (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap.metadata.hasPendingWrites),
      onErr);
  },
  watchDoc(name, id, cb) {
    return onSnapshot(doc(db, name, id),
      (snap) => cb(snap.exists() ? snap.data() : null, snap.metadata.hasPendingWrites),
      onErr);
  },
  add: (name, data) => safe(addDoc(collection(db, name), data)),
  addStrict: (name, data) => addDoc(collection(db, name), data),
  set: (name, id, data) => safe(setDoc(doc(db, name, id), data)),
  remove: (name, id) => safe(deleteDoc(doc(db, name, id))),
  logout: () => signOut(auth)
};

// ===== 主網站用：與 localStorage 相同的介面，資料實際存在雲端 =====
const CHUNK = 250000;   // 每段字數上限，確保單一文件不超過 Firestore 的 1MB
const cache = {};       // key -> 字串（同步讀取用）
const nChunks = {};     // key -> 目前存成幾段
let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch((e) => console.error(e)); return queue; };

function splitChunks(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + CHUNK, s.length);
    const code = s.charCodeAt(end - 1);
    if (end < s.length && code >= 0xD800 && code <= 0xDBFF) end -= 1; // 不切斷中間的字元
    out.push(s.slice(i, end));
    i = end;
  }
  return out.length ? out : [""];
}

async function persist(key) {
  const enc = encodeURIComponent(key);
  const old = nChunks[key] || 0;
  if (!Object.prototype.hasOwnProperty.call(cache, key)) {
    for (let i = 0; i < old; i++) await deleteDoc(doc(db, "kv", enc + "#" + i));
    await deleteDoc(doc(db, "kv", enc));
    delete nChunks[key];
    return;
  }
  const parts = splitChunks(cache[key]);
  for (let i = 0; i < parts.length; i++) await setDoc(doc(db, "kv", enc + "#" + i), { d: parts[i] });
  await setDoc(doc(db, "kv", enc), { n: parts.length });
  for (let i = parts.length; i < old; i++) await deleteDoc(doc(db, "kv", enc + "#" + i));
  nChunks[key] = parts.length;
}

async function preload() {
  const snap = await getDocs(collection(db, "kv"));
  const meta = {}, parts = {};
  snap.forEach((d) => {
    const id = d.id, data = d.data();
    const h = id.lastIndexOf("#");
    if (h < 0) meta[id] = data.n || 0;
    else {
      const enc = id.slice(0, h), i = +id.slice(h + 1);
      (parts[enc] = parts[enc] || [])[i] = data.d || "";
    }
  });
  Object.keys(meta).forEach((enc) => {
    const key = decodeURIComponent(enc), arr = parts[enc] || [];
    let s = "";
    for (let i = 0; i < meta[enc]; i++) s += arr[i] || "";
    cache[key] = s;
    nChunks[key] = meta[enc];
  });
}

export const KV = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : null; },
  setItem(k, v) { cache[k] = String(v); enqueue(() => persist(k)); },
  removeItem(k) { delete cache[k]; enqueue(() => persist(k)); }
};

// 找出這台裝置上「還沒上傳」的舊資料，顯示上傳按鈕
function offerMigration() {
  const pending = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !k.startsWith("adm:") && !Object.prototype.hasOwnProperty.call(cache, k)) pending.push(k);
    }
  } catch (e) { return; }
  if (!pending.length) return;
  const bar = document.createElement("div");
  bar.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99998;background:#fff3c4;color:#4d4a47;padding:8px 12px;text-align:center;font:14px/1.6 'Noto Sans TC','PingFang TC',sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.15)";
  const txt = document.createElement("span");
  txt.textContent = "這台裝置有舊資料（只存在這台裝置）。";
  const b = document.createElement("button");
  b.textContent = "上傳到雲端";
  b.style.cssText = "margin-left:8px;border:0;border-radius:999px;padding:4px 14px;font:inherit;background:#86ab98;color:#fff;cursor:pointer";
  b.onclick = async () => {
    b.disabled = true; b.textContent = "上傳中…";
    try {
      for (const k of pending) {
        cache[k] = localStorage.getItem(k) || "";
        await persist(k);
      }
      bar.remove();
      alert("舊資料已上傳到雲端");
    } catch (e) {
      console.error(e);
      alert("上傳失敗，請確認網路後再試一次");
      b.disabled = false; b.textContent = "上傳到雲端";
    }
  };
  bar.append(txt, b);
  document.body.appendChild(bar);
}

// 主網站各頁入口：先登入與權限檢查 → 載入雲端資料 → 才執行頁面程式
export function startApp() {
  gate(async () => {
    try {
      await preload();
    } catch (e) {
      console.error(e);
      alert("資料載入失敗，請重新整理或確認網路");
      return;
    }
    window.KV = KV;
    offerMigration();
    document.querySelectorAll('script[type="text/plain"][data-app]').forEach((s) => {
      const el = document.createElement("script");
      el.textContent = s.textContent;
      s.replaceWith(el);
    });
  });
}
