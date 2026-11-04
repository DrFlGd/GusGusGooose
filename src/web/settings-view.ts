// Settings: for now, where the desktop app keeps its library. The app is
// portable, so the library starts next to it; it can be moved to any folder
// (a synced folder, another disk), with its builds or without them, and put
// back next to the app. In the browser the library lives in the browser's
// storage and there is nothing to choose.

import { dialog, h } from './prepare-image.ts';
import { isDesktop, libraryInfo, openLibraryFolder, pickLibraryFolder, setLibraryFolder, type LibraryInfo } from './library-store.ts';

export function openSettings(opts: { status: (s: string) => void; libraryChanged: () => void }) {
  const d = dialog('Settings', false, () => {});
  d.element.classList.add('settings');
  d.footer.append(h('button', { type: 'button', class: 'primary', onclick: () => d.close() }, 'Done'));
  if (!isDesktop()) {
    d.body.append(
      h('h3', { class: 'lib-group-title' }, 'Library'),
      h('p', null, 'In the browser, saved builds are kept in this browser\'s own storage. The desktop app keeps them as files in a folder you can choose: next to the app by default, or anywhere else.'));
    return;
  }
  const path = h('code', { class: 'settings-path', id: 'settings-library-path' }, '…');
  const where = h('p', { class: 'small muted', id: 'settings-library-note' });
  const move = h('input', { type: 'checkbox', id: 'settings-move', checked: true }) as HTMLInputElement;
  const msg = h('p', { class: 'small', id: 'settings-message', 'aria-live': 'polite' });
  const choose = h('button', { type: 'button', id: 'settings-choose', class: 'primary' }, 'Move library…') as HTMLButtonElement;
  const reset = h('button', { type: 'button', id: 'settings-reset' }, 'Back next to the app') as HTMLButtonElement;
  const open = h('button', { type: 'button', id: 'settings-open' }, 'Show folder');
  let info: LibraryInfo | null = null;

  const show = async () => {
    info = await libraryInfo();
    path.textContent = info.path;
    where.textContent = info.custom
      ? `A folder you chose. The default is next to the app: ${info.defaultPath}.`
      : info.portable
        ? 'Next to the app, so the app and its builds can be moved or copied together (a USB stick, a synced folder).'
        : 'The app\'s own folder cannot be written to, so the library is in your user data folder. Move the app somewhere you can write (your Documents or a USB stick) to keep the library next to it, or choose a folder here.';
    reset.disabled = !info.custom;
    reset.title = info.custom ? '' : 'It is already in the default place';
  };
  const apply = async (target: string | null) => {
    const moving = move.checked && (info?.builds ?? 0) > 0;
    msg.textContent = moving ? 'Moving the builds…' : 'Switching…';
    for (const b of [choose, reset]) b.disabled = true;
    try {
      const r = await setLibraryFolder(target, move.checked);
      await show();
      const text = move.checked
        ? `The library is now in ${info!.path}. ${r.moved} build${r.moved === 1 ? '' : 's'} moved${r.skipped ? `; ${r.skipped} left behind because the new folder already had builds with the same id` : ''}.`
        : `The library is now in ${info!.path}. The builds in the old folder stayed there.`;
      msg.textContent = text;
      opts.status(text);
      opts.libraryChanged();
    } catch (err) {
      msg.textContent = `Could not use that folder: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      choose.disabled = false;
      await show().catch(() => {});
    }
  };
  choose.onclick = async () => {
    const folder = await pickLibraryFolder();
    if (folder) await apply(folder);
  };
  reset.onclick = () => apply(null);
  open.onclick = () => { openLibraryFolder().catch((err) => { msg.textContent = String(err); }); };

  d.body.append(
    h('h3', { class: 'lib-group-title' }, 'Library folder'),
    path,
    where,
    h('div', { class: 'row' }, choose, reset, open),
    h('label', { class: 'check' }, move, h('span', null, 'Take my saved builds along when the library moves. Off: the new folder is used as it is (for a library already there), and the old builds stay where they were.')),
    msg);
  show().catch((err) => { path.textContent = `Unknown: ${err}`; });
}
