export const $ = id => document.getElementById(id);

let accountId;
export function useAccount(id) { accountId = id; }

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, body, delta) {
  const headers = {};
  if (accountId && !['session', 'login', 'health'].includes(path)) headers['X-Inori-Account'] = accountId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (delta) headers.Accept = 'application/x-ndjson';
  let response;
  try {
    response = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers, cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(0, '連不上房間服務。請檢查網路後再試。');
  }
  if (response.headers.get('content-type')?.includes('application/x-ndjson') && delta) {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) throw new RequestError(0, '串流中斷。可以重新送出同一則訊息。');
        buffer += next.value;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const part = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (part.error) throw new RequestError(part.status, part.error);
          if (part.result) return part.result;
          if (part.delta) delta(part.delta);
          newline = buffer.indexOf('\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(response.status, result.error || '服務暫時無法使用。');
  return result;
}

export function node(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}

export function option(label, value) {
  const item = node('option', label);
  item.value = value ?? label;
  return item;
}

export function button(label, click) {
  const element = node('button', label, 'quiet');
  element.type = 'button';
  element.onclick = click;
  return element;
}

export function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = node('a');
  anchor.download = name;
  anchor.href = url;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function bindForm(id, status, handler, onError) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.submitter || $(id).querySelector('button:not([type="button"])');
    if (!submit || submit.disabled) return;
    submit.disabled = true;
    $(status).textContent = '';
    try { await handler(); }
    catch (error) {
      $(status).textContent = error.message;
      onError?.(error);
    } finally { submit.disabled = false; }
  });
}

export function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
