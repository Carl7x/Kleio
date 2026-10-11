/** Configuration and process handoff helpers for the unmodified Harness application. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function deepSeekMessagesBase(input) {
  const endpoint = new URL(input);
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('The model endpoint must use HTTP or HTTPS.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('The model endpoint cannot contain credentials, query parameters or a fragment.');
  const path = endpoint.pathname.replace(/\/$/, '');
  if (endpoint.hostname === 'api.deepseek.com' && ['', '/v1'].includes(path)) endpoint.pathname = '/anthropic';
  return endpoint.href.replace(/\/$/, '');
}

export async function openNativeBrowser(bin, url) {
  const opener = createRequire(bin).resolve('open');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|HOME)$/i.test(key)));
  const child = spawn(process.execPath, ['--input-type=module', '--eval', 'const {default:open}=await import(process.argv[1]); await open(process.argv[2]);', pathToFileURL(opener).href, url], { env, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('The browser could not be opened.'))); });
}
