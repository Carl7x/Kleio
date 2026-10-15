import { getRandomValues, randomUUID } from 'expo-crypto';
import { registerRootComponent } from 'expo';
import App from './App';

// Supply the original client's UUID primitives on native runtimes.
globalThis.crypto ??= {};
globalThis.crypto.getRandomValues ??= getRandomValues;
globalThis.crypto.randomUUID ??= randomUUID;

registerRootComponent(App);
