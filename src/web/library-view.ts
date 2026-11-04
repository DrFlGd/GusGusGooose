// The Library mode: saved builds filed under holidays and categories. The left
// column picks a collection, a tag or a search; the middle shows the builds as
// cards with their thumbnails; the right column edits the chosen build's name,
// description, collection and tags, and opens it in the editor again.

import { dialog, h } from './prepare-image.ts';
import { KIND_WORDS, libraryStore, matches, newId, parseTags, pointWords, safeName, type BuildMeta, type Collection } from './library-store.ts';

export { matches, parseTags };

export interface LibraryHost {
  /** opens a saved build in the editor */
  open(meta: BuildMeta): Promise<void>;
  status(s: string): void;
  /** hands an export to the browser download or the desktop Save dialog */
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>;
  /** the build open in the editor, if it came from the library */
  currentId(): string | null;
}

/** What the person fills in when saving: the rest of the meta comes from the build. */
export interface BuildDetails { name: string; description: string; tags: string[]; collection: string }

type Filter = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'collection'; id: string };
type Sort = 'updated' | 'name' | 'created';

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export class LibraryView {
  private store = libraryStore();
  private builds: BuildMeta[] = [];
  private collections: Collection[] = [];
  private filter: Filter = { kind: 'all' };
  private tagFilter = new Set<string>();
  private query = '';
  private sort: Sort = 'updated';
  private selected: string | null = null;
  private thumbs = new Map<string, { updated: number; url: string | null }>();
  private loaded = false;

  constructor(
    private host: LibraryHost,
    private els: { side: HTMLElement; grid: HTMLElement; detail: HTMLElement },
  ) {}

  /** Reads the library again and redraws it. */
  async refresh() {
    try {
      [this.builds, this.collections] = await Promise.all([this.store.list(), this.store.collections()]);
    } catch (err) {
      this.host.status(`The library could not be read: ${(err as Error).message}`);
      this.builds = [];
    }
    this.loaded = true;
    if (this.selected && !this.builds.some((b) => b.id === this.selected)) this.selected = null;
    this.render();
  }

  async show() { await this.refresh(); }

  /** Picks a build (after saving one, say) and shows its collection. */
  async reveal(id: string) {
    await this.refresh();
    const m = this.builds.find((b) => b.id === id);
    if (!m) return;
    this.selected = id;
    if (this.filter.kind === 'collection' && this.filter.id !== m.collection) this.filter = { kind: 'all' };
    this.render();
  }

  allTags(): string[] {
    const seen = new Map<string, string>();
    for (const b of this.builds) for (const t of b.tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  async getCollections(): Promise<Collection[]> {
    if (!this.loaded) await this.refresh();
    return this.collections;
  }

  private collectionName(id: string) { return this.collections.find((c) => c.id === id)?.name ?? ''; }

  private visible(): BuildMeta[] {
    let list = this.builds;
    const f = this.filter;
    if (f.kind === 'unfiled') list = list.filter((b) => !b.collection || !this.collections.some((c) => c.id === b.collection));
    else if (f.kind === 'collection') list = list.filter((b) => b.collection === f.id);
    if (this.tagFilter.size) list = list.filter((b) => [...this.tagFilter].every((t) => b.tags.some((x) => x.toLowerCase() === t)));
    if (this.query) list = list.filter((b) => matches(b, this.query, this.collectionName(b.collection)));
    const by: Record<Sort, (a: BuildMeta, b: BuildMeta) => number> = {
      updated: (a, b) => b.updated - a.updated,
      created: (a, b) => b.created - a.created,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...list].sort(by[this.sort]);
  }

  private async thumb(m: BuildMeta): Promise<string | null> {
    const have = this.thumbs.get(m.id);
    if (have && have.updated === m.updated) return have.url;
    if (have?.url) URL.revokeObjectURL(have.url);
    const bytes = m.files.includes('thumb.png') ? await this.store.read(m.id, 'thumb.png') : null;
    const url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })) : null;
    this.thumbs.set(m.id, { updated: m.updated, url });
    return url;
  }

  private thumbImg(m: BuildMeta, cls: string) {
    const box = h('div', { class: `lib-thumb ${cls}` }, h('span', { class: 'lib-thumb-empty' }, KIND_WORDS[m.kind]));
    void this.thumb(m).then((url) => { if (url) box.replaceChildren(h('img', { src: url, alt: '' })); });
    return box;
  }

  render() {
    this.renderSide();
    this.renderGrid();
    this.renderDetail();
  }

  // ---------- left: search, collections, tags ----------
  private renderSide() {
    const el = this.els.side;
    const count = (f: Filter) => {
      if (f.kind === 'all') return this.builds.length;
      if (f.kind === 'unfiled') return this.builds.filter((b) => !b.collection || !this.collections.some((c) => c.id === b.collection)).length;
      return this.builds.filter((b) => b.collection === f.id).length;
    };
    const same = (a: Filter, b: Filter) => a.kind === b.kind && (a.kind !== 'collection' || a.id === (b as { id: string }).id);
    const item = (label: string, f: Filter, extra?: HTMLElement) => h('li', { class: same(this.filter, f) ? 'active' : '' },
      h('button', { type: 'button', class: 'lib-col', onclick: () => { this.filter = f; this.render(); } },
        h('span', { class: 'lib-col-name' }, label), h('span', { class: 'lib-count' }, String(count(f)))),
      extra ?? null);
    const group = (g: Collection['group'], title: string) => {
      const list = this.collections.filter((c) => c.group === g);
      return h('div', { class: 'lib-group' },
        h('h3', { class: 'lib-group-title' }, title),
        h('ul', { class: 'lib-cols' }, ...list.map((c) => item(c.name, { kind: 'collection', id: c.id },
          h('button', { type: 'button', class: 'icon lib-col-edit', title: `Rename or remove ${c.name}`, 'aria-label': `Edit ${c.name}`, onclick: () => this.editCollection(c) }, '…')))));
    };
    const search = h('input', { type: 'search', id: 'lib-search', placeholder: 'Search names, tags, descriptions', value: this.query }) as HTMLInputElement;
    search.oninput = () => { this.query = search.value.trim(); this.renderGrid(); };
    const tags = this.allTags();
    el.replaceChildren(
      h('div', { class: 'step' },
        h('h2', null, 'Library'),
        search,
        h('ul', { class: 'lib-cols lib-cols-top' }, item('All builds', { kind: 'all' }), item('Not in a collection', { kind: 'unfiled' }))),
      h('div', { class: 'step' }, group('holiday', 'Holidays'), group('category', 'Categories'),
        h('div', { class: 'row' }, h('button', { type: 'button', id: 'lib-add-collection', onclick: () => this.editCollection(null) }, '+ New collection'))),
      h('div', { class: 'step' },
        h('h3', { class: 'lib-group-title' }, 'Tags'),
        tags.length
          ? h('div', { class: 'lib-tags' }, ...tags.map((t) => {
            const on = this.tagFilter.has(t.toLowerCase());
            return h('button', { type: 'button', class: `lib-tag${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => { if (on) this.tagFilter.delete(t.toLowerCase()); else this.tagFilter.add(t.toLowerCase()); this.render(); } }, t);
          }))
          : h('p', { class: 'small muted' }, 'Tags you give builds show here; click one to show only builds with it.'),
        this.tagFilter.size ? h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { this.tagFilter.clear(); this.render(); } }, 'Clear tag filter')) : null),
      h('div', { class: 'step' }, h('p', { class: 'small muted', id: 'lib-where' }, 'Saved in …')),
    );
    void this.store.where().then((w) => {
      const p = el.querySelector('#lib-where');
      if (p) p.textContent = this.store.kind === 'desktop' ? `Saved as files in ${w}. Each build is a folder you can back up or copy.` : `Saved in ${w}. The desktop app keeps its library as files instead; clearing this site's data clears this one.`;
    });
  }

  private async editCollection(c: Collection | null) {
    const name = h('input', { type: 'text', value: c?.name ?? '', placeholder: 'Mother\'s Day, Pets, Sports…' }) as HTMLInputElement;
    const group = h('select', null, h('option', { value: 'holiday' }, 'Holiday'), h('option', { value: 'category' }, 'Category')) as HTMLSelectElement;
    group.value = c?.group ?? 'holiday';
    const d = dialog(c ? `Edit ${c.name}` : 'New collection', false, () => {});
    d.body.append(h('label', null, 'Name', name), h('label', null, 'Group', group));
    if (c) {
      const n = this.builds.filter((b) => b.collection === c.id).length;
      d.body.append(h('p', { class: 'small muted' }, n ? `${n} build${n === 1 ? '' : 's'} in it. Removing the collection keeps them, under Not in a collection.` : 'No builds in it.'));
      d.footer.append(h('button', { type: 'button', class: 'danger', onclick: async () => {
        this.collections = this.collections.filter((x) => x.id !== c.id);
        await this.store.setCollections(this.collections);
        if (this.filter.kind === 'collection' && this.filter.id === c.id) this.filter = { kind: 'all' };
        d.close();
        this.render();
      } }, 'Remove'), h('span', { class: 'grow' }));
    }
    const save = async () => {
      const v = name.value.trim();
      if (!v) { name.focus(); return; }
      if (c) { c.name = v; c.group = group.value as Collection['group']; }
      else {
        let id = safeName(v.toLowerCase().replace(/\s+/g, '-')).replace(/_/g, '-') || newId();
        while (this.collections.some((x) => x.id === id)) id += '-2';
        this.collections.push({ id, name: v, group: group.value as Collection['group'] });
        this.filter = { kind: 'collection', id };
      }
      await this.store.setCollections(this.collections);
      d.close();
      this.render();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') void save(); });
    d.footer.append(h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'button', class: 'primary', onclick: save }, c ? 'Save' : 'Add'));
    name.focus();
  }

  // ---------- middle: the cards ----------
  private renderGrid() {
    const el = this.els.grid;
    const list = this.visible();
    const f = this.filter;
    const title = f.kind === 'all' ? 'All builds' : f.kind === 'unfiled' ? 'Not in a collection' : this.collectionName(f.id);
    const sort = h('select', { id: 'lib-sort', 'aria-label': 'Sort' },
      h('option', { value: 'updated' }, 'Last edited'), h('option', { value: 'created' }, 'Newest'), h('option', { value: 'name' }, 'Name')) as HTMLSelectElement;
    sort.value = this.sort;
    sort.onchange = () => { this.sort = sort.value as Sort; this.renderGrid(); };
    const head = h('div', { class: 'lib-head' },
      h('div', null, h('h2', null, title), h('p', { class: 'small muted' }, `${list.length} build${list.length === 1 ? '' : 's'}${this.query ? ` matching "${this.query}"` : ''}${this.tagFilter.size ? `, tagged ${[...this.tagFilter].join(' and ')}` : ''}`)),
      sort);
    let body: HTMLElement;
    if (!this.builds.length) {
      body = h('div', { class: 'lib-empty' },
        h('h3', null, 'Nothing saved yet'),
        h('p', { class: 'muted' }, 'Make an accessory or a garment, then Save to library on the right of the editor. It keeps the model, its settings, the fitted part and its paint, so you can open it here and keep editing.'));
    } else if (!list.length) {
      body = h('div', { class: 'lib-empty' }, h('p', { class: 'muted' }, 'No builds here. Try another collection, or clear the search and tags.'));
    } else {
      const current = this.host.currentId();
      body = h('div', { class: 'lib-grid', role: 'list' }, ...list.map((m) => {
        const card = h('button', { type: 'button', role: 'listitem', class: `lib-card${m.id === this.selected ? ' active' : ''}`, 'data-id': m.id, title: m.description || m.name },
          this.thumbImg(m, ''),
          h('span', { class: 'lib-card-body' },
            h('span', { class: 'lib-card-name' }, m.name || 'Untitled'),
            h('span', { class: 'lib-card-sub' }, [this.collectionName(m.collection), m.point ? pointWords(m.point) : KIND_WORDS[m.kind]].filter(Boolean).join(' · ')),
            m.tags.length ? h('span', { class: 'lib-card-tags' }, ...m.tags.slice(0, 4).map((t) => h('span', { class: 'lib-tag small' }, t))) : null),
          m.id === current ? h('span', { class: 'lib-badge' }, 'Open') : null);
        card.onclick = () => { this.selected = m.id; this.renderGrid(); this.renderDetail(); };
        card.ondblclick = () => void this.host.open(m);
        return card;
      }));
    }
    el.replaceChildren(head, body);
  }

  // ---------- right: the chosen build ----------
  private renderDetail() {
    const el = this.els.detail;
    const m = this.builds.find((b) => b.id === this.selected);
    if (!m) {
      el.replaceChildren(h('section', { class: 'group-static' },
        h('h2', { class: 'panel-title' }, 'Build'),
        h('p', { class: 'small muted' }, this.builds.length ? 'Pick a build to see and edit its details; double-click to open it in the editor.' : 'Saved builds show here.')));
      return;
    }
    const name = h('input', { type: 'text', id: 'lib-name', value: m.name }) as HTMLInputElement;
    const desc = h('textarea', { id: 'lib-desc', rows: '4', placeholder: 'What it is, what to print it in, what to watch for…' }) as HTMLTextAreaElement;
    desc.value = m.description;
    const col = this.collectionSelect(m.collection);
    col.id = 'lib-collection';
    const tags = h('input', { type: 'text', id: 'lib-tags', value: m.tags.join(', '), placeholder: 'santa, red, winter', list: 'lib-tag-list' }) as HTMLInputElement;
    const commit = async () => {
      const next: BuildMeta = { ...m, name: name.value.trim() || m.name, description: desc.value.trim(), collection: col.value, tags: parseTags(tags.value) };
      if (JSON.stringify([next.name, next.description, next.collection, next.tags]) === JSON.stringify([m.name, m.description, m.collection, m.tags])) return;
      next.updated = Date.now();
      // keep the thumbnail's cached url: the picture did not change
      const t = this.thumbs.get(m.id);
      if (t) t.updated = next.updated;
      try {
        await this.store.save(next, {});
        Object.assign(m, next);
        this.renderSide();
        this.renderGrid();
        this.host.status(`Saved the details of ${next.name}.`);
      } catch (err) { this.host.status(`Could not save: ${(err as Error).message}`); }
    };
    for (const x of [name, desc, tags]) x.addEventListener('change', commit);
    col.onchange = commit;
    const thumbFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' }) as HTMLInputElement;
    thumbFile.onchange = async () => {
      const f = thumbFile.files?.[0];
      if (!f) return;
      try {
        const png = await squarePng(f);
        const next = { ...m, updated: Date.now(), files: [...new Set([...m.files, 'thumb.png'])] };
        await this.store.save(next, { 'thumb.png': png });
        Object.assign(m, next);
        this.render();
      } catch (err) { this.host.status(`That picture could not be used: ${(err as Error).message}`); }
    };
    const info = [
      ['Made from', m.sourceName || (m.kind === 'garment' ? 'the goose body (a plain shirt)' : '—')],
      ['Kind', KIND_WORDS[m.kind] + (m.point ? `, on the ${pointWords(m.point)}` : '')],
      ['Fitted part', m.fitted ? `${(m.faces ?? 0).toLocaleString()} faces` : 'not fitted yet'],
      ['Created', when(m.created)],
      ['Last edited', when(m.updated)],
    ];
    const exportable = m.files.includes('part.3mf');
    el.replaceChildren(
      h('section', { class: 'group-static' },
        h('h2', { class: 'panel-title' }, 'Build'),
        this.thumbImg(m, 'large'),
        h('div', { class: 'row' }, h('label', { class: 'btn file-btn' }, thumbFile, 'Replace picture…')),
        h('div', { class: 'export', style: { marginTop: '12px' } },
          h('button', { type: 'button', id: 'lib-open', class: 'primary export-btn', onclick: () => void this.host.open(m) }, h('span', null, 'Open in editor'), h('small', null, 'Loads the model, its settings and its paint to keep working on it')),
          h('button', { type: 'button', id: 'lib-export', class: 'export-btn', disabled: !exportable, onclick: () => void this.exportBuild(m) }, h('span', null, '3MF with colours'), h('small', null, exportable ? 'The fitted part as it was saved, without opening it' : 'Fit it in the editor and save again to export from here')))),
      h('section', { class: 'group-static' },
        h('label', null, 'Name', name),
        h('label', null, 'Collection', col),
        h('label', null, 'Tags', tags, h('span', { class: 'small muted' }, 'Separate with commas')),
        h('datalist', { id: 'lib-tag-list' }, ...this.allTags().map((t) => h('option', { value: t }))),
        h('label', null, 'Description', desc)),
      h('section', { class: 'group-static' },
        h('dl', { class: 'lib-info' }, ...info.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        m.colours?.length ? h('div', { class: 'lib-colours' }, ...m.colours.map((c) => h('span', { class: 'lib-colour', title: c.name }, h('span', { class: 'chip-swatch', style: { background: c.color } }), c.name))) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', id: 'lib-duplicate', onclick: () => void this.duplicate(m) }, 'Duplicate'),
          h('button', { type: 'button', id: 'lib-delete', class: 'danger', onclick: () => this.confirmDelete(m) }, 'Delete'))),
    );
  }

  collectionSelect(value: string): HTMLSelectElement {
    const opt = (c: Collection) => h('option', { value: c.id }, c.name);
    const sel = h('select', null,
      h('option', { value: '' }, 'None'),
      h('optgroup', { label: 'Holidays' }, ...this.collections.filter((c) => c.group === 'holiday').map(opt)),
      h('optgroup', { label: 'Categories' }, ...this.collections.filter((c) => c.group === 'category').map(opt))) as HTMLSelectElement;
    sel.value = this.collections.some((c) => c.id === value) ? value : '';
    return sel;
  }

  private async exportBuild(m: BuildMeta) {
    const bytes = await this.store.read(m.id, 'part.3mf');
    if (!bytes) { this.host.status('This build has no saved 3MF.'); return; }
    if (await this.host.saveFile(`${safeName(m.name)}.3mf`, bytes)) this.host.status(`Exported ${m.name}.`);
  }

  private async duplicate(m: BuildMeta) {
    this.host.status(`Copying ${m.name}…`);
    try {
      const files: Record<string, Uint8Array> = {};
      for (const f of m.files) { const b = await this.store.read(m.id, f); if (b) files[f] = b; }
      const now = Date.now();
      const copy: BuildMeta = { ...m, id: newId(), name: `${m.name} copy`, created: now, updated: now, files: Object.keys(files), tags: [...m.tags] };
      await this.store.save(copy, files);
      this.selected = copy.id;
      await this.refresh();
      this.host.status(`Copied as ${copy.name}.`);
    } catch (err) { this.host.status(`Could not copy: ${(err as Error).message}`); }
  }

  private confirmDelete(m: BuildMeta) {
    const d = dialog(`Delete ${m.name}?`, false, () => {});
    d.body.append(h('p', null, 'The build, its model, settings, paint and thumbnail are removed from the library. Files you exported stay where you saved them.'));
    d.footer.append(
      h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'),
      h('button', { type: 'button', id: 'lib-delete-confirm', class: 'danger', onclick: async () => {
        d.close();
        try {
          await this.store.remove(m.id);
          const t = this.thumbs.get(m.id);
          if (t?.url) URL.revokeObjectURL(t.url);
          this.thumbs.delete(m.id);
          this.selected = null;
          await this.refresh();
          this.host.status(`Deleted ${m.name}.`);
        } catch (err) { this.host.status(`Could not delete: ${(err as Error).message}`); }
      } }, 'Delete'));
  }

  /**
   * The Save to library dialog: name, collection, tags and description, with the
   * thumbnail that will be kept. Resolves with what was entered, or null.
   */
  async detailsDialog(opts: { title: string; initial: BuildDetails; thumbUrl: string | null; note?: string; saveAsNew?: boolean }): Promise<(BuildDetails & { asNew: boolean }) | null> {
    await this.getCollections();
    return new Promise((resolve) => {
      let answer: (BuildDetails & { asNew: boolean }) | null = null;
      const d = dialog(opts.title, false, () => resolve(answer));
      d.element.classList.add('lib-save');
      const name = h('input', { type: 'text', id: 'save-name', value: opts.initial.name }) as HTMLInputElement;
      const col = this.collectionSelect(opts.initial.collection);
      col.id = 'save-collection';
      const tags = h('input', { type: 'text', id: 'save-tags', value: opts.initial.tags.join(', '), placeholder: 'santa, red, winter', list: 'save-tag-list' }) as HTMLInputElement;
      const desc = h('textarea', { id: 'save-desc', rows: '3', placeholder: 'What it is, what to print it in…' }) as HTMLTextAreaElement;
      desc.value = opts.initial.description;
      d.body.append(
        h('div', { class: 'lib-save-top' },
          opts.thumbUrl ? h('div', { class: 'lib-thumb' }, h('img', { src: opts.thumbUrl, alt: 'Thumbnail' })) : null,
          h('div', { class: 'lib-save-fields' }, h('label', null, 'Name', name), h('label', null, 'Collection', col))),
        h('label', null, 'Tags', tags, h('span', { class: 'small muted' }, 'Separate with commas')),
        h('datalist', { id: 'save-tag-list' }, ...this.allTags().map((t) => h('option', { value: t }))),
        h('label', null, 'Description', desc),
        h('p', { class: 'small muted' }, opts.note ?? 'The thumbnail is the view as it is now; turn the view and save again to change it, or replace it with a picture in the Library.'));
      const done = (asNew: boolean) => {
        const v = name.value.trim();
        if (!v) { name.focus(); return; }
        answer = { name: v, collection: col.value, tags: parseTags(tags.value), description: desc.value.trim(), asNew };
        d.close();
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(false); });
      d.footer.append(h('button', { type: 'button', onclick: () => d.close() }, 'Cancel'));
      if (opts.saveAsNew) d.footer.append(h('button', { type: 'button', id: 'save-as-new', onclick: () => done(true) }, 'Save as new'));
      d.footer.append(h('button', { type: 'button', id: 'save-confirm', class: 'primary', onclick: () => done(false) }, opts.saveAsNew ? 'Save changes' : 'Save'));
      name.select();
    });
  }
}

/** A picture made into a 512 px square PNG (centred, cropped), for a thumbnail. */
export async function squarePng(file: Blob, size = 512): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const s = Math.min(bmp.width, bmp.height);
  c.getContext('2d')!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  bmp.close();
  return canvasPng(c);
}

export function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('no picture'))), 'image/png'));
}
