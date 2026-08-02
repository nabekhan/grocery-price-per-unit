const storage = globalThis.browser?.storage || globalThis.chrome?.storage;
const select = globalThis.document.querySelector('#default-sort-mode');
const saved = globalThis.document.querySelector('#saved');

async function initialize() {
  try {
    const result = await storage.sync.get({ defaultSortMode: 'restore' });
    select.value = result.defaultSortMode;
  } catch {
    saved.textContent = 'Settings storage is unavailable.';
    select.disabled = true;
  }
}

select.addEventListener('change', async () => {
  saved.textContent = '';
  try {
    await storage.sync.set({ defaultSortMode: select.value });
    saved.textContent = 'Saved and applied to open pages.';
  } catch { saved.textContent = 'Could not save this setting.'; }
});

initialize();
