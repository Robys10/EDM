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
  getFirestore, doc, getDoc, setDoc, onSnapshot
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
      const datos = limpiar(payload);
      const tamano = new Blob([JSON.stringify(datos)]).size;
      if (tamano > LIMITE_BYTES) {
        console.error('[EDM] El estado pesa ' + tamano + ' bytes y supera el límite de Firestore (~1 MiB). ' +
          'No se guardó en la nube. Hay que dividir los datos en varios documentos.');
        return false;
      }
      await setDoc(ref, datos);
      guardarRespaldoDiario(datos);
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
