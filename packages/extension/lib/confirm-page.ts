/// <reference lib="dom" />
/** The policy confirmation page (entrypoints/confirm.html). */
const id = new URLSearchParams(location.search).get('id') ?? '';

async function main(): Promise<void> {
  const stored = await chrome.storage.session.get(`policy-request:${id}`);
  const req = stored[`policy-request:${id}`] as { changes: string[] } | undefined;
  const list = document.getElementById('changes')!;
  if (!req) {
    document.getElementById('ask')!.style.display = 'none';
    const done = document.getElementById('done')!;
    done.style.display = 'block';
    done.textContent = 'This request has expired.';
    return;
  }
  for (const c of req.changes) {
    const li = document.createElement('li');
    li.textContent = c;
    list.appendChild(li);
  }
  const answer = async (approve: boolean): Promise<void> => {
    await chrome.runtime.sendMessage({ target: 'byob-policy', id, approve });
    window.close();
  };
  document.getElementById('allow')!.addEventListener('click', () => void answer(true));
  document.getElementById('reject')!.addEventListener('click', () => void answer(false));
}

void main();
