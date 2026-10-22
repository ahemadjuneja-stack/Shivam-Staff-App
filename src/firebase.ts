import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, memoryLocalCache } from "firebase/firestore";

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
export const db = initializeFirestore(app, {
  localCache: memoryLocalCache()
});

