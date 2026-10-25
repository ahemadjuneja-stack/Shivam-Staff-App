import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAziP_2HxsFH7RXeo5RNq8qvaawMamnYAQ",
  authDomain: "shivam-staff-ff7d5.firebaseapp.com",
  projectId: "shivam-staff-ff7d5",
  storageBucket: "shivam-staff-ff7d5.firebasestorage.app",
  messagingSenderId: "133240405311",
  appId: "1:133240405311:web:580508a8412b199ce6e78a",
  measurementId: "G-W9HPF0RNRC"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// CACHE (Boss order 2026-10-25: "app me Cache add karo smoothly chalna chahiye"):
// pehle memoryLocalCache() tha — cache sirf RAM me, app band = GAYAB,
// har cold start pe saara data network se dobara download hota tha.
// Ab persistentLocalCache: Firestore data phone ke IndexedDB me save —
// cold start pe listeners turant cached data se render (0 network wait),
// phir background me sync; offline me bhi last data dikhta hai.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

