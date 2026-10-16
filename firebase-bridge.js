/* =====================================================================
   firebase-bridge.js  ·  EDM ’26
   Conecta la página con Firebase (Firestore + Auth) y expone
   window.firebaseBridge, que es lo que el index.html espera:
     - cargarEstadoFirestore()            -> objeto del estado o null
     - guardarEstadoFirestore(payload)    -> true / false
     - suscribirCambiosFirestore(cb)      -> función para cancelar
     - loginWithGoogle()                  -> user
     - logout()
   Es JavaScript normal (no TypeScript): no necesita compilar nada.
   ===================================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

/* ---------------------------------------------------------------------
   1) PEGA AQUÍ la configuración web de tu proyecto de Firebase.
      Consola de Firebase > Configuración del proyecto (⚙) > Tus apps >
      App web > "Configuración del SDK". La configuración web de Firebase
      no es un secreto; la seguridad real está en firestore.rules.
   --------------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: 'AIzaSyADIjjL2eICz23sODpPfV3xzwziY_99fwo',
  authDomain: 'pagina-27cb0.firebaseapp.com',
  projectId: 'pagina-27cb0',
  storageBucket: 'pagina-27cb0.firebasestorage.app',
  messagingSenderId: '706159863714',
  appId: '1:706159863714:web:afb130a16bf738d378f4fb'
};

const COLECCION = 'promo';
const DOCUMENTO = 'estado';
const COLECCION_RESPALDOS = 'promo_respaldos';
const LIMITE_BYTES = 950000; // Firestore admite ~1 MiB por documento


/* ---------- Fusión de estados (evita que dos guardados simultáneos se pisen) ---------- */
const MAX_BORRADOS = 1000;
const claveItem = (x) => String((x && (x.id || x.url || ((x.name || '') + '_' + (x.date || '')))) || '');
const claveId = (x) => String((x && x.id) || '');
function estaBorrado(x, del) {
  if (!x) return true;
  if (x.id && del.has(String(x.id))) return true;
  if (x.url && del.has(String(x.url))) return true;
  if (x.fileId && del.has(String(x.fileId))) return true;
  if (x.tgMessageId && del.has('tg_msg_' + x.tgMessageId)) return true;
  return false;
}
function fusionarLista(local, nube, getKey, del) {
  const mapa = new Map();
  (nube || []).forEach(x => { if (!x || estaBorrado(x, del)) return; const k = getKey(x); if (k) mapa.set(k, x); });
  (local || []).forEach(x => {
    if (!x || estaBorrado(x, del)) return;
    const k = getKey(x); if (!k) return;
    const o = mapa.get(k);
    if (!o || Number(x.updatedAt || 0) >= Number(o.updatedAt || 0)) mapa.set(k, x);
  });
  const salida = [], vistos = new Set();
  (local || []).forEach(x => { const k = x && getKey(x); if (k && mapa.has(k) && !vistos.has(k)) { salida.push(mapa.get(k)); vistos.add(k); } });
  mapa.forEach((v, k) => { if (!vistos.has(k)) salida.push(v); });
  return salida;
}
function fusionarAlbumes(local, nube, del) {
  const m = new Map();
  [...(nube || []), ...(local || [])].forEach(a => {
    const n = String((a && typeof a === 'object' ? a.name : a) || '').trim();
    if (!n) return;
    const low = n.toLowerCase();
    if (del.has('alb_' + low) || m.has(low)) return;
    m.set(low, a);
  });
  return Array.from(m.values());
}
function fusionarEstados(local, nube) {
  const borrados = Array.from(new Set([...(nube.deletedIds || []), ...(local.deletedIds || [])].map(String))).slice(-MAX_BORRADOS);
  const del = new Set(borrados);
  const boveda = { ...(nube.titlesVault || {}) };
  Object.entries(local.titlesVault || {}).forEach(([k, v]) => {
    const o = boveda[k];
    if (!o || Number((v && v.updatedAt) || 0) >= Number((o && o.updatedAt) || 0)) boveda[k] = v;
  });
  return {
    ...local,
    revision: Date.now(),
    deletedIds: borrados,
    albums: fusionarAlbumes(local.albums, nube.albums, del),
    items: fusionarLista(local.items, nube.items, claveItem, del),
    tweets: fusionarLista(local.tweets, nube.tweets, claveId, del),
    members: fusionarLista(local.members, nube.members, claveId, del),
    awards: fusionarLista(local.awards, nube.awards, claveId, del),
    capsules: fusionarLista(local.capsules, nube.capsules, claveId, del),
    events: fusionarLista(local.events, nube.events, claveId, del),
    titlesVault: boveda
  };
}

const sinConfigurar = Object.values(firebaseConfig).some(v => String(v).startsWith('PEGA_AQUI'));

if (sinConfigurar) {
  console.warn('[EDM] firebase-bridge.js: falta pegar la configuración de Firebase. ' +
    'La página seguirá funcionando solo con respaldo local.');
} else {
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const ref = doc(db, COLECCION, DOCUMENTO);

  /* Todos los visitantes inician sesión de forma anónima para poder leer/escribir
     según las reglas. "Conectar Google" sigue siendo opcional. */
  const listo = new Promise((resolve) => {
    let resuelto = false;
    const fin = () => { if (!resuelto) { resuelto = true; resolve(); } };
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        try { await signInAnonymously(auth); }
        catch (e) {
          console.warn('[EDM] No se pudo iniciar sesión anónima. Activa "Anónimo" en ' +
            'Firebase > Authentication > Método de acceso.', e);
          fin();
        }
        return;
      }
      fin();
      if (typeof window.actualizarUIAuthFirebase === 'function') {
        window.actualizarUIAuthFirebase(user.isAnonymous ? null : user);
      }
    });
    setTimeout(fin, 6000); // nunca bloquear la página
  });

  const limpiar = (obj) => JSON.parse(JSON.stringify(obj)); // quita "undefined", que Firestore rechaza

  async function guardarRespaldoDiario(datos) {
    try {
      const hoy = new Date().toISOString().slice(0, 10);
      const clave = 'edm26_ultimo_respaldo_nube';
      if (localStorage.getItem(clave) === hoy) return;
      // Solo se crea (las reglas impiden sobrescribir): conserva el primer estado del día.
      await setDoc(doc(db, COLECCION_RESPALDOS, hoy), { creadoEn: new Date().toISOString(), estado: datos });
      localStorage.setItem(clave, hoy);
    } catch (e) {
      // Si ya existía el respaldo de hoy o falla, no pasa nada.
      try { localStorage.setItem('edm26_ultimo_respaldo_nube', new Date().toISOString().slice(0, 10)); } catch (_) {}
    }
  }

  window.firebaseBridge = {
    async cargarEstadoFirestore() {
      await listo;
      const snap = await getDoc(ref);
      return snap.exists() ? snap.data() : null;
    },

    async guardarEstadoFirestore(payload) {
      await listo;
      const local = limpiar(payload);
      let final = null;
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          final = snap.exists() ? fusionarEstados(local, snap.data()) : local;
          const tamano = new Blob([JSON.stringify(final)]).size;
          if (tamano > LIMITE_BYTES) throw new Error('LIMITE_TAMANO:' + tamano);
          tx.set(ref, limpiar(final));
        });
      } catch (e) {
        if (String(e && e.message).startsWith('LIMITE_TAMANO')) {
          console.error('[EDM] El estado supera el limite de Firestore (~1 MiB). No se guardo en la nube. ' +
            'Hay que dividir los datos en varios documentos.', e.message);
          return false;
        }
        throw e;
      }
      window.firebaseBridge.ultimoEstadoNube = final; // la pagina lo usa para mostrar lo que subieron otros
      guardarRespaldoDiario(final);
      return true;
    },

    suscribirCambiosFirestore(callback) {
      let cancelar = () => {};
      let cancelado = false;
      listo.then(() => {
        if (cancelado) return;
        cancelar = onSnapshot(ref, (snap) => {
          if (snap.metadata.hasPendingWrites) return; // ignorar el eco de mis propios cambios
          if (snap.exists()) callback(snap.data());
        }, (err) => console.warn('[EDM] Error en escucha en tiempo real:', err));
      });
      return () => { cancelado = true; cancelar(); };
    },

    async loginWithGoogle() {
      await listo;
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      return cred.user;
    },

    async logout() {
      await signOut(auth); // onAuthStateChanged vuelve a entrar como anónimo
    }
  };
}
