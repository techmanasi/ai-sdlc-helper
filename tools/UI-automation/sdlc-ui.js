// sdlc-ui: read and drive the ai-sdlc-helper web UI from inside the page, without reading the whole DOM each time.
//
// Load it into the page (browser console, a Chrome automation `javascript_tool` call, or a bookmarklet), then call
// `sdlcUI.snapshot()` for a short summary of the screen, or the functions below to read one thing or press one button.
// `sdlcUI.help()` lists them. Every selector is in SELECTORS: when the UI's markup changes, change it there
// (test/ui-automation.test.ts fails when a selector no longer appears in web/ui/src).
//
// Plain browser script, no imports, no build: it sets `globalThis.sdlcUI` and returns it.
(function sdlcUiTool(root) {
  'use strict';
  const VERSION = 1;

  /** Every hook into the UI's markup (web/ui/src). Class and id names only; buttons are found by their label. */
  const SELECTORS = {
    main: 'main.main',
    project: '#proj',
    version: '.brand .muted',
    counts: '.counts .chip',
    toast: '.toasts .toast',
    navItem: 'nav.nav a.navi',
    error: '.error',
    banner: '.banner',
    // board / completed
    completedTab: '.completed-tab',
    completedSearch: '#completed-search',
    completedBranch: '.completed-branch',
    completedStageBar: '.completed-stage-bar',
    completedStageNote: '.completed-stage-note',
    boardRow: '.blist .brow',
    rowSlug: '.brow-slug',
    rowSub: '.brow-sub',
    rowStrip: '.strip',
    rowSeg: '.bseg',
    rowSegItem: '.bseg-seg',
    rowChip: '.chip',
    rowPr: '.b-pr',
    rowUpdated: '.b-updated',
    rowActions: '.brow-acts',
    rowCheckbox: 'input[type="checkbox"]',
    boardFilter: '#flt',
    segGroup: '.segs',
    seg: '.seg',
    segOn: 'seg-on',
    runningTag: '.tag',
    drawerOutput: 'pre.code',
    projectReviewLimit: '#review-loop-limit',
    runReviewLimit: '#review-loop-override',
    runSyncRounds: '#review-sync-rounds',
    // run page
    hero: '.hero',
    heroTitle: '.hero h1',
    heroChip: '.hero .chip',
    heroTag: '.hero .tag',
    stopKind: '#stop-kind',
    stopCause: '#stop-cause',
    guarantee: '.guar .guar-item',
    recovery: 'section.recov',
    recoveryWays: '.recov-ways',
    discardedStage: '#discarded-stage',
    panel: 'section.pn',
    panelHead: '.ph h2',
    tile: '.rail2 .tile:not(.rail2-fold)',
    foldDone: '.rail2-fold',
    scrollStagesLeft: 'button[aria-label="Scroll stages left"]',
    scrollStagesRight: 'button[aria-label="Scroll stages right"]',
    tileName: '.tile-name',
    tileModel: '.tile-model',
    tileLine: '.tile-line',
    tileCost: '.tile-cost',
    tileLock: '.tile-lock',
    tileRound: '.tile-round',
    tilePr: '.tile-pr',
    paneBack: '.pane-back',
    paneFollowing: '.pane-following',
    openOutput: '.open-output',
    stageDetail: '#stage-detail',
    paneHeading: '.rail-controls .eyebrow',
    lockBadge: '.lock-badge',
    step: '.steps .step',
    stepLabel: '.step-label',
    stepTime: '.step-time',
    output: '#run-output',
    usageTable: 'table.usage',
    resumePick: '#resume-pick',
    openPick: '#open-pick',
    modelList: '.pick-list',
    modelId: '.pick-id',
    providerFilter: '.pick-provider',
    handoffFinding: '#handoff-finding',
    resumeNote: '#resume-note',
    totals: '.totals .total',
    rowCost: '.b-cost',
    question: 'textarea[id^="q"]',
    dialog: '[role="dialog"]',
    fileBody: '.file-md, pre.code',
    // new item / edit
    slug: '#slug',
    type: '#type',
    priority: '#prio',
    title: '#title',
    brief: '#brief',
    // code search setup
    codeSearchDialog: '[role="dialog"][aria-label="Code Search Setup"]',
    indexerCard: '.indexer-card',
    indexerStatus: '.indexer-status',
    indexerAction: '.indexer-action',
    buildOutput: 'pre.build-output',
  };

  const $ = (sel, from) => (from || document).querySelector(sel);
  const $$ = (sel, from) => Array.from((from || document).querySelectorAll(sel));
  const text = el => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const main = () => $(SELECTORS.main) || document.body;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && el.getClientRects().length > 0;
  /** The state a class like tile-active or guar-ok carries; part names (guar-item, tile-on, ...) are skipped. */
  const PARTS = ['on', 'item', 'after', 'mark', 'text', 'bar', 'fill', 'head'];
  const stateOf = (el, prefix) => {
    const c = Array.from(el.classList).find(x => x.startsWith(prefix) && !PARTS.includes(x.slice(prefix.length)));
    return c ? c.slice(prefix.length) : '';
  };

  /** Waits until <test> (a selector or a function) gives something truthy; returns it. */
  async function waitFor(test, { timeout = 15000, every = 100 } = {}) {
    const check = typeof test === 'string' ? () => $(test) : test;
    const end = Date.now() + timeout;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > end) throw new Error(`sdlcUI.waitFor: timed out after ${timeout} ms waiting for ${typeof test === 'string' ? test : 'a condition'}`);
      await sleep(every);
    }
  }

  /** Sets an input, textarea or select so the app (Preact) sees the change. */
  function setValue(el, value) {
    if (!el) throw new Error('sdlcUI.setValue: no element');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return el.value;
  }

  /** Ticks or unticks a checkbox through a click, so the app's own handler runs. */
  function setChecked(el, on) {
    if (!el) throw new Error('sdlcUI.setChecked: no checkbox');
    if (el.checked !== !!on) el.click();
    return el.checked;
  }

  /** The buttons and button links in <from> (default: the screen), with their labels. */
  function buttons(from) {
    return $$('button, a.btn', from || main()).filter(visible).map(b => ({
      label: text(b), disabled: !!b.disabled, tile: b.matches(SELECTORS.tile), inPanel: !!b.closest(SELECTORS.panel),
    }));
  }

  /** The button whose label is <label> (exact, then starting with it; case ignored), in <from> or the whole page. */
  function findButton(label, from) {
    const want = label.toLowerCase();
    const all = $$('button, a.btn', from || document).filter(visible);
    return all.find(b => text(b).toLowerCase() === want) || all.find(b => text(b).toLowerCase().startsWith(want)) || null;
  }

  /** Clicks the button labelled <label>; throws, naming the buttons there, when it is missing or disabled. */
  function click(label, from) {
    const b = findButton(label, from);
    if (!b) throw new Error(`sdlcUI.click: no button "${label}". Buttons here: ${buttons(from).map(x => x.label).join(' | ')}`);
    if (b.disabled) throw new Error(`sdlcUI.click: "${text(b)}" is disabled`);
    b.click();
    return text(b);
  }

  /** The section.pn panel whose heading starts with <title>. */
  function panel(title) {
    const want = title.toLowerCase();
    return $$(SELECTORS.panel, main()).find(p => text($(SELECTORS.panelHead, p)).toLowerCase().startsWith(want)) || null;
  }
  const panelTitles = () => $$(SELECTORS.panel, main()).map(p => text($(SELECTORS.panelHead, p))).filter(Boolean);

  // ---- frame ----
  const route = () => (location.hash.replace(/^#/, '') || '/board').split('?')[0];
  function go(path) { location.hash = path; return route(); }
  function top() {
    const chips = $$(SELECTORS.counts).map(text);
    const num = re => { const c = chips.find(x => re.test(x)); return c ? Number((c.match(/\d+/) || ['0'])[0]) : null; };
    const proj = $(SELECTORS.project);
    return { project: proj ? proj.value : '', version: text($(SELECTORS.version)), running: num(/running/), needYou: num(/need you/), failed: num(/failed/), title: document.title };
  }
  const toasts = () => $$(SELECTORS.toast).map(text);
  const errors = () => $$(SELECTORS.error, main()).map(text).filter(Boolean);

  // ---- board ----
  function board() {
    const rows = $$(SELECTORS.boardRow).map(row => {
      const box = $(SELECTORS.rowCheckbox, row);
      const subs = $$(SELECTORS.rowSub, row).map(text);
      const strip = $(SELECTORS.rowStrip, row);
      const seg = $(SELECTORS.rowSeg, row);
      const run = !box;
      const updated = $(SELECTORS.rowUpdated, row);
      let stageStates = [];
      let stagesLabel = '';
      if (seg) {
        stageStates = $$(SELECTORS.rowSegItem, seg).map(s => {
          const cls = Array.from(s.classList).find(c => c.startsWith('bseg-') && c !== 'bseg-seg' && c !== 'bseg-dash');
          return cls ? cls.slice(5) : 'not-reached';
        });
        stagesLabel = seg.getAttribute('aria-label') || '';
      } else if (strip) {
        stageStates = $$('i', strip).map(i => stateOf(i, 'st-') || 'pending');
        stagesLabel = strip.getAttribute('aria-label') || '';
      }
      return {
        slug: text($(SELECTORS.rowSlug, row)),
        kind: run ? 'run' : 'item',
        // a run: [branch · model, where it is]; an item: [type · priority · title, note]
        detail: subs[0] || '',
        where: subs[1] || '',
        status: text($(SELECTORS.rowChip, row)),
        stages: stagesLabel,
        stageStates,
        pr: text($(SELECTORS.rowPr, row)),
        updated: updated ? text(updated) : '',
        cost: text($(SELECTORS.rowCost, row)),
        selected: box ? box.checked : row.classList.contains('brow-on'),
        actions: buttons($(SELECTORS.rowActions, row)).map(b => b.label),
      };
    });
    const segs = $$(`${SELECTORS.segGroup}[aria-label="Show"] ${SELECTORS.seg}`).map(b => ({ label: text(b), on: b.classList.contains(SELECTORS.segOn) }));
    return { filter: ($(SELECTORS.boardFilter) || {}).value || '', show: segs, banner: text($(SELECTORS.banner, main())), rows };
  }
  const row = slug => $$(SELECTORS.boardRow).find(r => text($(SELECTORS.rowSlug, r)) === slug) || null;
  /** Shows All, Running, Needs you or Failed. */
  function boardShow(label) { return click(label, $(`${SELECTORS.segGroup}[aria-label="Show"]`)); }
  function boardFilter(value) { return setValue($(SELECTORS.boardFilter), value); }
  /** Ticks (or unticks) a backlog item for "Run selected". */
  function pick(slug, on = true) { return setChecked($(`input[aria-label="Select ${slug}"]`), on); }
  /** Clicks a button (Open, Answer, Sync PR, Edit, ...) on one row of the board. */
  function rowAction(slug, label) {
    const r = row(slug);
    if (!r) throw new Error(`sdlcUI.rowAction: no row ${slug} on the board`);
    return click(label, r);
  }

  // ---- run page ----
  function stages() {
    return $$(SELECTORS.tile).map(t => ({
      name: text($(SELECTORS.tileName, t)),
      state: stateOf(t, 'tile-'),
      model: text($(SELECTORS.tileModel, t)),
      line: text($(SELECTORS.tileLine, t)),
      cost: text($(SELECTORS.tileCost, t)),
      round: text($(SELECTORS.tileRound, t)),
      pr: text($(SELECTORS.tilePr, t)),
      lock: ($(SELECTORS.tileLock, t) || { getAttribute: () => '' }).getAttribute('aria-label') || '',
      selected: t.getAttribute('aria-selected') === 'true',
      pressed: t.getAttribute('aria-pressed') === 'true',
    }));
  }
  /** The leading done-stage fold, or null when every leading done tile is visible. */
  function doneFold() {
    const b = $(SELECTORS.foldDone);
    return b ? { text: text(b), label: b.getAttribute('aria-label') || '' } : null;
  }
  /** Unfolds the leading done stages; returns their fold label, or null when there was no fold. */
  function unfoldDone() {
    const b = $(SELECTORS.foldDone);
    if (!b) return null;
    const label = b.getAttribute('aria-label') || '';
    b.click();
    return label;
  }
  /** Scrolls to the nearest hidden tile on one side; false when that side has no scroll button. */
  function scrollStages(direction) {
    const sel = direction === 'left' ? SELECTORS.scrollStagesLeft : direction === 'right' ? SELECTORS.scrollStagesRight : '';
    if (!sel) throw new Error('sdlcUI.scrollStages: direction must be "left" or "right"');
    const b = $(sel);
    if (!b) return false;
    b.click();
    return true;
  }
  /** Focuses and scrolls to the Output panel through the follow line's button. */
  function openOutput() {
    const b = $(SELECTORS.openOutput);
    if (!b) throw new Error('sdlcUI.openOutput: no Open output button (the pane is not following the running stage)');
    b.click();
    return document.activeElement === $(SELECTORS.output);
  }
  /** Picks a stage on the rail (the pane under it always shows one) and returns its steps. */
  async function stage(name) {
    const find = () => $$(SELECTORS.tile).find(x => text($(SELECTORS.tileName, x)).toLowerCase() === name.toLowerCase());
    let t = find();
    if (!t && $(SELECTORS.foldDone)) {
      unfoldDone();
      await waitFor(() => !$(SELECTORS.foldDone));
      t = find();
    }
    if (!t) throw new Error(`sdlcUI.stage: no stage ${name}; stages: ${stages().map(s => s.name).join(', ')}`);
    if (t.getAttribute('aria-selected') !== 'true') t.click();
    const d = await waitFor(SELECTORS.stageDetail);
    return {
      name,
      heading: text($(SELECTORS.paneHeading, d)),
      lock: text($(SELECTORS.lockBadge, d)),
      following: !$(SELECTORS.paneBack, d),
      steps: $$(SELECTORS.step, d).map(s => ({ label: text($(SELECTORS.stepLabel, s)), time: text($(SELECTORS.stepTime, s)), state: stateOf(s, 'step-') })),
      text: text(d).slice(0, 600),
    };
  }
  /** The last <n> lines of the run's output panel. */
  function output(n = 20) {
    const pre = $(SELECTORS.output);
    return pre ? (pre.textContent || '').split('\n').filter(l => l.trim()).slice(-n) : [];
  }
  function questions() {
    return $$(SELECTORS.question, main()).filter(t => /^q\d+$/.test(t.id)).map(t => {
      // <div class="col"><strong>Qn · title</strong><span>body</span><span>Suggested: …</span><div class="row">…textarea</div></div>
      const box = t.closest('.row');
      const q = box && box.parentElement ? box.parentElement : null;
      const parts = q ? Array.from(q.children).filter(c => c !== box).map(text) : [];
      return { n: Number(t.id.slice(1)), title: parts[0] || '', detail: parts.slice(1).join(' · ').slice(0, 500), answer: t.value };
    });
  }
  function answer(n, value) { return setValue($(`#q${n}`), value); }
  function recovery() {
    const r = $(SELECTORS.recovery);
    if (!r) return null;
    return { text: text(r).slice(0, 800), buttons: buttons(r).map(b => b.label) };
  }
  /** Why the run stopped: the kind's name and the cause the record gives; null while the run has not stopped. */
  function stopKind() {
    const k = $(SELECTORS.stopKind);
    if (!k) return null;
    const glyph = $('.stop-kind-glyph', k);
    return { label: text(k).replace(/^\S+\s*/, ''), glyph: glyph ? text(glyph) : '', cause: text($(SELECTORS.stopCause)) };
  }
  /** The "Environment for this run" rows as { NAME: value }. */
  function env() {
    const p = panel('Environment for this run');
    if (!p) return null;
    const names = $$('input[aria-label="Name"]', p);
    const values = $$('input[aria-label="Value"]', p);
    return Object.fromEntries(names.map((n, i) => [n.value, values[i] ? values[i].value : '']).filter(([k]) => k));
  }
  /** Sets one variable in "Environment for this run" (adds a row when it is not there). */
  async function setEnv(name, value) {
    const p = panel('Environment for this run');
    if (!p) throw new Error('sdlcUI.setEnv: no "Environment for this run" panel on this screen');
    const names = () => $$('input[aria-label="Name"]', p);
    let i = names().findIndex(n => n.value === name);
    if (i < 0) {
      // The quick button (SDLC_BASE, ...) adds a row named <name>; "Add variable" adds an empty one. Both render on the next tick.
      // A quick button with no default value (SDLC_BASE, ...) may add nothing; then "Add variable" is used.
      const before = names().length;
      const added = () => names().length > before;
      const quick = findButton(name, p);
      if (quick) { quick.click(); await waitFor(added, { timeout: 1000 }).catch(() => null); }
      if (!added()) { click('Add variable', p); await waitFor(added, { timeout: 3000 }); }
      i = names().findIndex(n => n.value === name);
      if (i < 0) { i = names().length - 1; setValue(names()[i], name); await sleep(50); }
    }
    setValue($$('input[aria-label="Value"]', p)[i], value);
    await sleep(50);
    return env();
  }
  function projectReviewLimit() { return $(SELECTORS.projectReviewLimit)?.value ?? null; }
  function setProjectReviewLimit(value) { return setValue($(SELECTORS.projectReviewLimit), value); }
  function setRunReviewLimit(value) {
    const input = $(SELECTORS.runReviewLimit);
    if (!input || input.disabled) throw new Error('Review loop limit override is unavailable');
    for (let d = input.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
    return setValue(input, value);
  }
  /** Ticks or clears "Sync the branch with GitHub before each fix round" for this run; returns the env table. */
  async function setSyncRounds(on) {
    const input = $(SELECTORS.runSyncRounds);
    if (!input || input.disabled) throw new Error('Sync before each fix round is unavailable');
    for (let d = input.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
    if (input.checked !== Boolean(on)) input.click();
    await sleep(50);
    return env();
  }
  function modelOptions() {
    return $$(SELECTORS.modelId, $(SELECTORS.modelList) || main()).map(text);
  }
  function runOptions() {
    const d = $$('details', main()).find(x => text($('summary', x)).startsWith('Run options'));
    if (!d) return null;
    const auto = $$('label', d).find(l => text(l).startsWith('Auto-accept'));
    const limit = $(SELECTORS.runReviewLimit, d);
    const sync = $(SELECTORS.runSyncRounds, d);
    return { summary: text($('summary', d)), autoAccept: auto ? $('input', auto).checked : null,
      reviewLoopLimit: limit?.value ?? null, reviewLoopLimitDisabled: limit?.disabled ?? null,
      syncEachRound: sync ? sync.checked : null };
  }
  function autoAccept(on) {
    const d = $$('details', main()).find(x => text($('summary', x)).startsWith('Run options'));
    if (!d) throw new Error('sdlcUI.autoAccept: no "Run options" on this screen');
    d.open = true;
    const l = $$('label', d).find(x => text(x).startsWith('Auto-accept'));
    return setChecked($('input', l), on);
  }
  function run() {
    const cost = panel('Cost and tokens');
    return {
      slug: text($(SELECTORS.heroTitle)),
      state: text($(SELECTORS.heroChip)),
      tags: $$(SELECTORS.heroTag).map(text),
      message: text($('.error', main())),
      guarantees: $$(SELECTORS.guarantee).map(g => `${stateOf(g, 'guar-')}: ${text(g)}`),
      stages: stages(),
      foldedDone: doneFold(),
      recovery: recovery(),
      stopKind: stopKind(),
      questions: questions().length,
      cost: cost ? text($('.chip', cost)) : '',
      totals: $$(SELECTORS.totals).map(text),
      handoff: handoff(),
      // a run ready after a stage discard: which stage was discarded and how to retry it
      discarded: text($(SELECTORS.discardedStage)),
      panels: panelTitles(),
      // the run's own buttons; the stage tiles are in stages, a panel's buttons are read through panel(<title>)
      buttons: buttons($('.col', main())).filter(b => !b.tile && !b.inPanel).map(b => b.label + (b.disabled ? ' (disabled)' : '')),
      output: output(8),
    };
  }
  /** The resume panel's pipeline finding and instruction box; null while the panel is closed. */
  function handoff() {
    const box = $(SELECTORS.resumeNote);
    if (!box) return null;
    return { finding: text($(SELECTORS.handoffFinding)), note: box.value };
  }
  /** Open "Resume at...", pick a stage by its label, type an instruction, press Go and confirm if asked. */
  async function resumeWithNote(stage, note) {
    if (!$(SELECTORS.resumePick)) click('Resume at', main());
    await waitFor(SELECTORS.resumePick);
    const l = $$('label', $(SELECTORS.resumePick)).find(x => text(x).toLowerCase().startsWith(stage.toLowerCase()));
    if (!l) throw new Error('sdlcUI.resumeWithNote: no stage "' + stage + '"');
    $('input', l).click();
    if (note !== undefined) setValue($(SELECTORS.resumeNote), note);
    click('Go', $(SELECTORS.resumePick));
    await sleep(300);
    const d = $(SELECTORS.dialog);
    if (d) click('Resume', d);
    return handoff();
  }
  /** The "Cost and tokens" table as rows of cells. */
  function costTable() {
    const t = $(SELECTORS.usageTable);
    return t ? $$('tr', t).map(r => $$('th, td', r).map(text)) : [];
  }
  /** Opens a file from the Documents panel (or any button "Open <file>") and returns its text once shown. */
  async function openDoc(name) {
    click(name, panel('Documents') || main());
    const d = await waitFor(() => $$(SELECTORS.dialog).find(x => x.querySelector(SELECTORS.fileBody)));
    return text(d).slice(0, 4000);
  }
  function closeDialog() { const d = $(SELECTORS.dialog); return d ? click('Close', d) : ''; }

  // ---- new item ----
  /** Fills the New item form (open it first with go('/new')). Leaves saving to click('Save') / click('Save and start'). */
  async function newItem({ slug, type, priority, title, brief }) {
    if (route() !== '/new') { go('/new'); }
    await waitFor(SELECTORS.slug);
    if (slug !== undefined) setValue($(SELECTORS.slug), slug);
    if (type !== undefined) setValue($(SELECTORS.type), type);
    if (priority !== undefined) {
      const sel = $(SELECTORS.priority);
      const opt = Array.from(sel.options).find(o => o.value.startsWith(priority));
      if (!opt) throw new Error(`sdlcUI.newItem: no priority ${priority}; choices: ${Array.from(sel.options).map(o => o.value).join(', ')}`);
      setValue(sel, opt.value);
    }
    if (title !== undefined) setValue($(SELECTORS.title), title);
    if (brief !== undefined) {
      if (!$(SELECTORS.brief)) click('Split');
      setValue(await waitFor(SELECTORS.brief), brief);
    }
    await sleep(50);
    return { slug: $(SELECTORS.slug).value, title: $(SELECTORS.title).value, briefChars: ($(SELECTORS.brief) || { value: '' }).value.length, buttons: buttons().filter(b => /^save/i.test(b.label)) };
  }

  function completedTabs() {
    return $$(SELECTORS.completedTab).map(t => {
      const bar = $(SELECTORS.completedStageBar, t);
      return {
        slug: text($('strong', t)), branch: text($(SELECTORS.completedBranch, t)), selected: t.getAttribute('aria-selected') === 'true',
        stages: bar ? bar.getAttribute('aria-label') || '' : '',
        stageStates: bar ? $$('i', bar).map(i => stateOf(i, 'st-')) : [],
        note: text($(SELECTORS.completedStageNote, t)),
      };
    });
  }
  function completedFilter(value) { setValue($(SELECTORS.completedSearch), value); }
  function selectCompleted(slug) {
    const tab = $$(SELECTORS.completedTab).find(t => text($('strong', t)) === slug);
    if (!tab) throw new Error(`No completed task named ${slug}`);
    tab.click();
  }

  /** The open Code Search Setup dialog: title and busy state. */
  function codeSearchDialog() {
    const d = $(SELECTORS.codeSearchDialog);
    return d ? { title: text($('h2', d)), busy: !!$('.cs-busy', d), errors: $$(SELECTORS.error, d).map(text) } : null;
  }

  /** One row per indexer card: name, badges, action labels and any captured build output. */
  function codeSearchIndexers() {
    return $$(SELECTORS.indexerCard).map(card => ({
      name: text($('h3', card)),
      badges: $$('.tag', $(SELECTORS.indexerStatus, card) || card).map(text),
      actions: $$(SELECTORS.indexerAction, card).map(b => ({ label: text(b), disabled: !!b.disabled })),
      output: text($(SELECTORS.buildOutput, card)),
    }));
  }

  /** The preformatted process output of a failed build, if one is showing. */
  function codeSearchOutput() { return text($(SELECTORS.buildOutput)); }

  /** A short summary of the current screen: start here. */
  function snapshot() {
    const r = route();
    const base = { route: r, top: top(), toasts: toasts(), errors: errors() };
    if (r.startsWith('/run/')) return { ...base, run: run() };
    if (r === '/completed') return { ...base, tasks: completedTabs(), panels: panelTitles() };
    if (r === '/board') {
      const b = board();
      return { ...base, board: { ...b, rows: b.rows.map(x => `${x.kind === 'run' ? '▶' : '·'} ${x.slug} | ${x.status} | ${x.where} | ${x.stages} | ${x.pr}`) } };
    }
    const dialog = codeSearchDialog();
    return {
      ...base, heading: text($('h1', main())), panels: panelTitles(), buttons: buttons().map(b => b.label),
      ...(dialog ? { codeSearch: { dialog, indexers: codeSearchIndexers(), output: codeSearchOutput() } } : {}),
    };
  }

  const api = {
    VERSION, SELECTORS,
    // frame
    route, go, top, toasts, errors, snapshot, waitFor, sleep,
    // generic
    click, buttons, findButton, panel, panelTitles, setValue, setChecked, text,
    // board
    board, boardShow, boardFilter, pick, rowAction,
    completedTabs, completedFilter, selectCompleted, handoff, resumeWithNote, projectReviewLimit, setProjectReviewLimit, setRunReviewLimit, setSyncRounds,
    // run page
    run, stages, stage, doneFold, unfoldDone, scrollStages, openOutput, output, questions, answer, recovery, stopKind, env, setEnv, modelOptions, runOptions, autoAccept, costTable, openDoc, closeDialog,
    // new item
    newItem,
    // code search setup
    codeSearchDialog, codeSearchIndexers, codeSearchOutput,
  };
  api.help = () => Object.keys(api).filter(k => typeof api[k] === 'function').join(', ');
  root.sdlcUI = api;
  // Kept in this origin's storage, so after a page reload `eval(localStorage.getItem('sdlc-ui-tool'))` loads it again.
  try { root.localStorage.setItem('sdlc-ui-tool', `(${sdlcUiTool.toString()})(globalThis)`); } catch { /* private window */ }
  return `sdlcUI v${VERSION} loaded: ${api.help()}`;
})(globalThis);
