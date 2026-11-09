// Toolbar of the Restless browser: navigation, address bar, the recording switch and a way back to the app.
import './browser.css';

interface State {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  paused: boolean;
  count: number;
}
interface Api {
  command(cmd: string, arg?: unknown): void;
  onState(cb: (s: State) => void): void;
  onFocusAddress(cb: () => void): void;
}
const api = (window as unknown as { restlessBrowser: Api }).restlessBrowser;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bar = $<HTMLFormElement>('bar');
const input = $<HTMLInputElement>('url');
const scheme = $('scheme');
const back = $<HTMLButtonElement>('back');
const forward = $<HTMLButtonElement>('forward');
const reload = $<HTMLButtonElement>('reload');
const rec = $<HTMLButtonElement>('rec');
const recLabel = $('rec-label');
const count = $('count');
let state: State | null = null;
let editing = false;

/** Show "localhost:3000/orders" with the scheme dimmed, like a browser does. */
function showUrl(url: string) {
  if (editing) return;
  const m = /^(https?:\/\/)(.*)$/.exec(url);
  scheme.textContent = m ? m[1] : '';
  input.value = m ? m[2] : url === 'about:blank' ? '' : url;
}

api.onState((s) => {
  state = s;
  showUrl(s.url);
  back.disabled = !s.canGoBack;
  forward.disabled = !s.canGoForward;
  reload.classList.toggle('loading', s.loading);
  reload.setAttribute('aria-label', s.loading ? 'Stop' : 'Reload');
  rec.setAttribute('aria-pressed', String(s.paused));
  recLabel.textContent = s.paused ? 'Paused' : 'Recording';
  rec.title = s.paused ? 'Recording is paused. Click to record again.' : 'Recording every API call and page load. Click to pause.';
  count.textContent = String(s.count);
  count.title = `${s.count} recorded`;
});

api.onFocusAddress(() => {
  input.focus();
  input.select();
});

input.addEventListener('focus', () => {
  editing = true;
  // While editing, show the full address.
  if (scheme.textContent) {
    input.value = scheme.textContent + input.value;
    scheme.textContent = '';
  }
  requestAnimationFrame(() => input.select());
});
input.addEventListener('blur', () => {
  editing = false;
  if (state) showUrl(state.url);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') input.blur();
});

bar.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  api.command('navigate', value);
  input.blur();
});

back.addEventListener('click', () => api.command('back'));
forward.addEventListener('click', () => api.command('forward'));
reload.addEventListener('click', () => api.command(state?.loading ? 'stop' : 'reload'));
rec.addEventListener('click', () => api.command('pause', !state?.paused));
$('show').addEventListener('click', () => api.command('show-app'));
