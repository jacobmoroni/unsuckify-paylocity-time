// ==UserScript==
// @name         Paylocity Clean Timesheet
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  A sane UI for entering Paylocity timesheet data
// @match        https://webtime2.paylocity.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const _pctyDebug = localStorage.getItem('pcty_debug');
    if (_pctyDebug) { console.log('[PCTY] Last save POST body:\n' + _pctyDebug); localStorage.removeItem('pcty_debug'); }
    const _pctyResp = localStorage.getItem('pcty_response');
    if (_pctyResp) { console.log('[PCTY] Last save response:\n' + _pctyResp); localStorage.removeItem('pcty_response'); }

    // ── CONFIGURE YOUR JOB CODES HERE ────────────────────────────────
    const JOB_CODES_DEFAULT = [
        { label: 'Regular',          value: '86/100/////////////',           payTypeId: '-1' },
        { label: 'Meeting',          value: '86/125/////////////',           payTypeId: '-1' },
        { label: 'PTO',              value: '86/150/////////////',           payTypeId: '4'  },
        { label: 'Floating Holiday', value: '86/150/////////////',           payTypeId: '13' },
    ];
    // ─────────────────────────────────────────────────────────────────

    function loadSavedCodes() {
        try { return JSON.parse(localStorage.getItem('pcty_saved_codes') || '[]'); } catch { return []; }
    }
    function saveCodes(codes) {
        localStorage.setItem('pcty_saved_codes', JSON.stringify(codes));
    }

    // All known codes: defaults seeded on first use, saved list is authoritative after that
    function allJobCodes() {
        const saved = loadSavedCodes();
        if (saved.length === 0) {
            // First run: seed from defaults (not favorited yet — user curates)
            const seeded = JOB_CODES_DEFAULT.map(d => ({ ...d }));
            saveCodes(seeded);
            return seeded;
        }
        return saved;
    }

    // Only favorites show in the initial grid
    function favoriteJobCodes() {
        return allJobCodes().filter(j => j.favorite);
    }

    function discoverPayTypes() {
        const types = [];
        document.querySelectorAll('select[name*="PayTypeId"], select[id*="PayType"], select[id*="payType"]').forEach(sel => {
            [...sel.options].forEach(o => {
                if (o.value && o.value !== '0' && o.value !== '-1' && !types.some(t => t.id === o.value)) {
                    types.push({ id: o.value, label: o.textContent.trim() });
                }
            });
        });
        return types;
    }

    const C = {
        bg: '#1e1e2e', bgAlt: '#181825', border: '#45475a',
        text: '#cdd6f4', muted: '#6c7086', input: '#313244',
        green: '#a6e3a1', red: '#f38ba8', purple: '#cba6f7',
        orange: '#fab387',
    };

    // ── DOM helpers ───────────────────────────────────────────────────

    function h(tag, props, ...children) {
        const e = document.createElement(tag);
        Object.entries(props || {}).forEach(([k, v]) => {
            if (k === 'style') e.style.cssText = v;
            else if (k === 'on') Object.entries(v).forEach(([ev, fn]) => e.addEventListener(ev, fn));
            else e[k] = v;
        });
        children.flat().forEach(c => c != null && e.append(typeof c === 'string' ? c : c));
        return e;
    }

    function inputCss(extra = '') {
        return `background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:4px;padding:3px 6px;font-family:inherit;font-size:12px;${extra}`;
    }

    // ── State parsing ─────────────────────────────────────────────────

    function getInput(name) {
        const sel = `input[name="${name.replace(/[[\].]/g, '\\$&')}"]`;
        const el = document.querySelector(sel);
        return el ? el.value : null;
    }

    function parseTimesheetState() {
        const startDate = getInput('RangeStartDate') || getInput('StartDate');
        const endDate   = getInput('RangeEndDate')   || getInput('EndDate');
        if (!startDate) return null;

        const tokenEl = document.querySelector('input[name="__RequestVerificationToken"]');
        const token = tokenEl ? tokenEl.value : '';
        const days = {};

        document.querySelectorAll('input[name], select[name]').forEach(inp => {
            const name = inp.name;
            let m;
            if ((m = name.match(/^TimeSheet\[(\d+)\]\.Date$/))) {
                const di = +m[1];
                days[di] = days[di] || { date: '', entries: {} };
                days[di].date = inp.value.split('T')[0];
                return;
            }
            if ((m = name.match(/^TimeSheet\[(\d+)\]\.Entries\[(\d+)\]\.(.+)$/))) {
                const di = +m[1], ei = +m[2], field = m[3];
                days[di] = days[di] || { date: '', entries: {} };
                days[di].entries[ei] = days[di].entries[ei] || {};
                days[di].entries[ei][field] = inp.value;
                return;
            }
            if ((m = name.match(/^TimeSheet_(\d+)__Entries_(\d+)__LaborLevel\.values$/))) {
                const di = +m[1], ei = +m[2];
                days[di] = days[di] || { date: '', entries: {} };
                days[di].entries[ei] = days[di].entries[ei] || {};
                days[di].entries[ei].LaborLevel = inp.value;
            }
        });

        const dummyLaborEl = document.querySelector('input[name="DummyTimesheetEntry_LaborLevel.values"]');
        const dummyLabor = dummyLaborEl ? dummyLaborEl.value : '86/100//////////////';

        return { token, startDate, endDate, days, dummyLabor };
    }

    // ── Utilities ─────────────────────────────────────────────────────

    function isWeekend(dateStr) {
        const d = new Date(dateStr + 'T12:00:00');
        return d.getDay() === 0 || d.getDay() === 6;
    }

    function fmtDateShort(dateStr) {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
    }

    // Strip trailing slash-padding and return only the numeric cost-center portion.
    // e.g. '62/100/6006 DRONE////////////' → '62/100/6006'
    //      '86/125///////////////'         → '86/125'
    function stripCostCenter(value) {
        if (!value) return '';
        const m = value.match(/^(\d+(?:\/\d+)*)/);
        return m ? m[1] : value.replace(/\/+$/, '').trim();
    }

    // Strip any manually-typed "(N/N)" suffix from a stored label.
    function baseLabel(label) {
        return label.replace(/\s*\([0-9/]+\)\s*$/, '').trim();
    }

    // Label + auto-derived cost center in parens, for use in dropdowns.
    function displayLabel(code) {
        const cc = stripCostCenter(code.value);
        return cc ? `${baseLabel(code.label)} (${cc})` : baseLabel(code.label);
    }

    // ── UI ────────────────────────────────────────────────────────────

    function buildUI(state) {
        document.getElementById('pcty-panel')?.remove();

        const sortedDays = Object.entries(state.days)
            .sort(([a], [b]) => +a - +b)
            .map(([idx, day]) => ({ di: +idx, ...day }));

        const workingDays = sortedDays.filter(d => !isWeekend(d.date)).length;

        const JOB_CODES = allJobCodes();

        // Unique key for a code slot = labor level + pay type
        function codeKey(value, payTypeId) { return value + '||' + (payTypeId || '-1'); }

        // Build code list: favorites first (in saved order), then non-favorite existing entries alphabetically
        const codeList = favoriteJobCodes().map(jc => ({ label: jc.label, value: jc.value, payTypeId: jc.payTypeId || '-1', unknown: false }));
        const nonFavExtras = [];
        sortedDays.forEach(({ entries }) => {
            Object.values(entries).forEach(entry => {
                if (entry.LaborLevel && parseFloat(entry.Duration) > 0) {
                    const pid = entry.PayTypeId || '-1';
                    const key = codeKey(entry.LaborLevel, pid);
                    if (!codeList.some(c => codeKey(c.value, c.payTypeId) === key) &&
                        !nonFavExtras.some(c => codeKey(c.value, c.payTypeId) === key)) {
                        const known = JOB_CODES.find(j => codeKey(j.value, j.payTypeId || '-1') === key);
                        const payTypeName = pid !== '-1' ? discoverPayTypes().find(t => t.id === pid) : null;
                        const fallbackLabel = payTypeName ? payTypeName.label : (pid !== '-1' ? `${entry.LaborLevel} (type ${pid})` : entry.LaborLevel);
                        nonFavExtras.push({ label: known ? known.label : fallbackLabel, value: entry.LaborLevel, payTypeId: pid, unknown: !known });
                    }
                }
            });
        });
        nonFavExtras.sort((a, b) => a.label.localeCompare(b.label));
        codeList.push(...nonFavExtras);

        // grid[codeIdx][di] = { hours, existing, ei }
        const grid = codeList.map(() => ({}));
        sortedDays.forEach(({ di, entries }) => {
            Object.entries(entries).forEach(([eiStr, entry]) => {
                const ei = +eiStr;
                const pid = entry.PayTypeId || '-1';
                const key = codeKey(entry.LaborLevel, pid);
                const codeIdx = codeList.findIndex(c => codeKey(c.value, c.payTypeId) === key);
                if (codeIdx >= 0 && parseFloat(entry.Duration) > 0) {
                    grid[codeIdx][di] = { hours: parseFloat(entry.Duration), existing: entry, ei };
                }
            });
        });

        // Max ei per day, for assigning indices to new entries
        const maxEiByDi = {};
        sortedDays.forEach(({ di, entries }) => {
            const eis = Object.keys(entries).map(Number);
            maxEiByDi[di] = eis.length > 0 ? Math.max(...eis) : -1;
        });

        // ── Update totals ─────────────────────────────────────────────

        function updateTotals() {
            let periodTotal = 0;
            sortedDays.forEach(({ di, date }) => {
                let dayTotal = 0;
                panel.querySelectorAll(`.pcty-cell[data-di="${di}"]`).forEach(inp => {
                    dayTotal += parseFloat(inp.value) || 0;
                });
                const totalEl = panel.querySelector(`.pcty-total[data-di="${di}"]`);
                if (totalEl) {
                    totalEl.textContent = dayTotal > 0 ? dayTotal : '0';
                    const weekend = isWeekend(date);
                    totalEl.style.color = dayTotal === 0 ? (weekend ? C.muted : C.text) : dayTotal < 8 ? C.orange : C.green;
                }
                periodTotal += dayTotal;
            });
            const periodEl = panel.querySelector('#pcty-period-total');
            if (periodEl) {
                const target = workingDays * 8;
                periodEl.textContent = `${periodTotal % 1 === 0 ? periodTotal : periodTotal.toFixed(1)} / ${target} hrs`;
                periodEl.style.color = periodTotal >= target ? C.green : C.muted;
            }
        }

        // ── Table construction ────────────────────────────────────────

        const CELL_W = '54px';
        const LABEL_W = '90px';

        function cellTdStyle(weekend) {
            return `padding:1px 2px;text-align:center;border-right:1px solid ${C.border};border-bottom:1px solid ${C.border};background:${weekend ? C.bgAlt : C.bg};`;
        }

        const labelTdStyle = `padding:3px 8px;border-right:2px solid ${C.border};border-bottom:1px solid ${C.border};position:sticky;left:0;background:${C.bg};z-index:1;white-space:nowrap;min-width:${LABEL_W};`;

        function makeCellInput(di, ci, initialHours, weekend) {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.min = '0';
            inp.max = '24';
            inp.step = '0.25';
            inp.value = initialHours > 0 ? String(initialHours) : '';
            inp.className = 'pcty-cell';
            inp.dataset.di = String(di);
            inp.dataset.ci = String(ci);
            inp.style.cssText = `width:${CELL_W};text-align:center;font-family:inherit;font-size:12px;color:${weekend ? C.muted : C.text};background:transparent;border:none;outline:none;padding:2px 0;display:block;-moz-appearance:textfield;-webkit-appearance:none;appearance:textfield;`;
            inp.addEventListener('wheel', e => e.preventDefault(), { passive: false });
            inp.addEventListener('input', updateTotals);
            inp.addEventListener('focus', () => { if (weekend) inp.style.color = C.text; });
            inp.addEventListener('blur',  () => { if (weekend && !inp.value) inp.style.color = C.muted; });
            return inp;
        }

        function makeCodeRow(ci, code) {
            const removeBtn = h('button', {
                type: 'button',
                style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:13px;padding:0 0 0 6px;line-height:1;vertical-align:middle;opacity:0.5;`,
                title: 'Remove row',
            }, '×');

            const baseName = baseLabel(code.label);
            const cc = stripCostCenter(code.value);
            const labelCell = h('td', { style: labelTdStyle },
                h('span', { style: `font-size:12px;color:${code.unknown ? C.orange : C.text};vertical-align:middle;` }, baseName),
                cc ? h('span', { style: `font-size:10px;color:${C.muted};margin-left:5px;vertical-align:middle;font-family:ui-monospace,monospace;` }, cc) : null,
                removeBtn
            );

            if (code.unknown) {
                const saveBtn = h('button', {
                    type: 'button',
                    style: `background:none;border:1px solid ${C.orange};color:${C.orange};border-radius:3px;font-size:10px;padding:1px 5px;cursor:pointer;margin-left:5px;font-family:inherit;vertical-align:middle;`,
                    title: 'Save this code so it is remembered',
                }, 'save?');
                saveBtn.addEventListener('click', () => {
                    const saved = loadSavedCodes();
                    const idx = saved.findIndex(s => codeKey(s.value, s.payTypeId || '-1') === codeKey(code.value, code.payTypeId));
                    const entry = { label: code.label, value: code.value, payTypeId: code.payTypeId || '-1' };
                    if (idx >= 0) saved[idx] = entry;
                    else saved.push(entry);
                    saveCodes(saved);
                    codeList[ci] = { ...codeList[ci], unknown: false };
                    labelCell.querySelector('span').style.color = C.text;
                    saveBtn.remove();
                });
                labelCell.append(saveBtn);
            }

            const cells = sortedDays.map(({ di, date }) => {
                const weekend = isWeekend(date);
                const cell = grid[ci] && grid[ci][di];
                return h('td', { style: cellTdStyle(weekend) },
                    makeCellInput(di, ci, cell ? cell.hours : 0, weekend)
                );
            });

            const row = h('tr', {}, labelCell, ...cells);
            removeBtn.addEventListener('click', () => { row.remove(); updateTotals(); });
            return row;
        }

        // Header row
        const thead = h('thead', {},
            h('tr', {},
                h('th', { style: `${labelTdStyle}border-bottom:2px solid ${C.border};font-size:11px;color:${C.muted};font-weight:normal;text-transform:uppercase;` }, 'Time Code'),
                ...sortedDays.map(({ date }) => {
                    const weekend = isWeekend(date);
                    return h('th', {
                        style: `padding:4px 2px;font-size:11px;font-weight:normal;text-align:center;white-space:nowrap;width:${CELL_W};min-width:${CELL_W};border-right:1px solid ${C.border};border-bottom:2px solid ${C.border};background:${weekend ? C.bgAlt : C.bg};color:${weekend ? C.muted : C.text};`
                    }, fmtDateShort(date));
                })
            )
        );

        const tbody = h('tbody');
        codeList.forEach((code, ci) => tbody.append(makeCodeRow(ci, code)));

        // Total row
        const totalCells = sortedDays.map(({ di, date }) => {
            const weekend = isWeekend(date);
            const td = document.createElement('td');
            td.style.cssText = `padding:4px 2px;text-align:center;font-size:12px;font-weight:bold;border-right:1px solid ${C.border};border-top:2px solid ${C.border};background:${weekend ? C.bgAlt : C.bg};color:${C.text};`;
            td.className = 'pcty-total';
            td.dataset.di = String(di);
            td.textContent = '0';
            return td;
        });

        const totalRow = h('tr', {},
            h('td', { style: `${labelTdStyle}border-top:2px solid ${C.border};border-bottom:none;font-weight:bold;color:${C.green};font-size:12px;` }, 'Total'),
            ...totalCells
        );
        tbody.append(totalRow);

        const tbl = h('table', { style: 'border-collapse:collapse;' }, thead, tbody);

        // "+ add code row" — dropdown of all known codes not already in the grid
        function rebuildGrid() {
            const snapshot = {};
            codeList.forEach((code, ci) => {
                const key = codeKey(code.value, code.payTypeId);
                snapshot[key] = {};
                sortedDays.forEach(({ di }) => {
                    const inp = panel.querySelector(`.pcty-cell[data-di="${di}"][data-ci="${ci}"]`);
                    if (inp && inp.value !== '') snapshot[key][di] = inp.value;
                });
            });

            codeList.length = 0;
            favoriteJobCodes().forEach(jc => codeList.push({ label: jc.label, value: jc.value, payTypeId: jc.payTypeId || '-1', unknown: false }));
            const nonFavExtras = [];
            sortedDays.forEach(({ entries }) => {
                Object.values(entries).forEach(entry => {
                    if (entry.LaborLevel && parseFloat(entry.Duration) > 0) {
                        const pid = entry.PayTypeId || '-1';
                        const key = codeKey(entry.LaborLevel, pid);
                        if (!codeList.some(c => codeKey(c.value, c.payTypeId) === key) &&
                            !nonFavExtras.some(c => codeKey(c.value, c.payTypeId) === key)) {
                            const known = allJobCodes().find(j => codeKey(j.value, j.payTypeId || '-1') === key);
                            nonFavExtras.push({ label: known ? known.label : entry.LaborLevel, value: entry.LaborLevel, payTypeId: pid, unknown: !known });
                        }
                    }
                });
            });
            nonFavExtras.sort((a, b) => a.label.localeCompare(b.label));
            codeList.push(...nonFavExtras);

            grid.length = 0;
            codeList.forEach(() => grid.push({}));
            sortedDays.forEach(({ di, entries }) => {
                Object.entries(entries).forEach(([eiStr, entry]) => {
                    const ei = +eiStr;
                    const pid = entry.PayTypeId || '-1';
                    const key = codeKey(entry.LaborLevel, pid);
                    const ci = codeList.findIndex(c => codeKey(c.value, c.payTypeId) === key);
                    if (ci >= 0 && parseFloat(entry.Duration) > 0) {
                        grid[ci][di] = { hours: parseFloat(entry.Duration), existing: entry, ei };
                    }
                });
            });

            [...tbody.querySelectorAll('tr')].forEach(r => { if (r !== totalRow) r.remove(); });
            codeList.forEach((code, ci) => {
                const row = makeCodeRow(ci, code);
                const key = codeKey(code.value, code.payTypeId);
                if (snapshot[key]) {
                    sortedDays.forEach(({ di }) => {
                        if (snapshot[key][di] != null) {
                            const inp = row.querySelector(`.pcty-cell[data-di="${di}"]`);
                            if (inp) inp.value = snapshot[key][di];
                        }
                    });
                }
                totalRow.before(row);
            });
            updateTotals();
        }

        function addCodeRow(preselectedKey) {
            const available = allJobCodes().filter(jc => !codeList.some(c => codeKey(c.value, c.payTypeId) === codeKey(jc.value, jc.payTypeId || '-1')));
            if (available.length === 0) return;
            const code = available.find(jc => codeKey(jc.value, jc.payTypeId || '-1') === preselectedKey) || available[0];
            const ci = codeList.length;
            codeList.push({ label: code.label, value: code.value, payTypeId: code.payTypeId || '-1', unknown: false });
            grid.push({});

            const sel = document.createElement('select');
            sel.style.cssText = `background:transparent;border:none;color:${C.text};font-family:inherit;font-size:12px;max-width:110px;outline:none;cursor:pointer;`;
            available.forEach(jc => {
                const o = document.createElement('option');
                o.value = codeKey(jc.value, jc.payTypeId || '-1');
                o.textContent = displayLabel(jc);
                if (codeKey(jc.value, jc.payTypeId || '-1') === codeKey(code.value, code.payTypeId || '-1')) o.selected = true;
                sel.append(o);
            });
            sel.addEventListener('change', function () {
                const found = allJobCodes().find(jc => codeKey(jc.value, jc.payTypeId || '-1') === this.value);
                codeList[ci] = found
                    ? { label: found.label, value: found.value, payTypeId: found.payTypeId || '-1', unknown: false }
                    : codeList[ci];
            });

            const removeBtn = h('button', {
                type: 'button',
                style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:13px;padding:0 0 0 4px;line-height:1;opacity:0.5;`,
            }, '×');

            const cells = sortedDays.map(({ di, date }) => {
                const weekend = isWeekend(date);
                return h('td', { style: cellTdStyle(weekend) },
                    makeCellInput(di, ci, 0, weekend)
                );
            });

            const row = h('tr', {},
                h('td', { style: labelTdStyle }, sel, removeBtn),
                ...cells
            );

            removeBtn.addEventListener('click', () => { row.remove(); updateTotals(); });
            totalRow.before(row);
            updateTotals();
        }

        // "Edit saved codes" collapsible section
        function buildManageCodesSection() {
            const body = h('div', { style: 'display:none;margin-top:8px;' });
            let open = false;

            const toggle = h('button', {
                type: 'button',
                style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:12px;padding:6px 0;font-family:inherit;`,
            }, '▶ Edit saved codes');

            toggle.addEventListener('click', () => {
                open = !open;
                toggle.textContent = (open ? '▼' : '▶') + ' Edit saved codes';
                body.style.display = open ? 'block' : 'none';
                if (open) renderList();
            });

            function renderList() {
                body.innerHTML = '';
                const codes = allJobCodes();
                const payTypes = discoverPayTypes();

                if (codes.length === 0) {
                    body.append(h('span', { style: `font-size:11px;color:${C.muted};` }, 'No saved codes yet. Use the "save?" button on an unrecognized row.'));
                    return;
                }

                body.append(h('div', { style: `display:flex;align-items:center;gap:2px;padding:0 0 2px 0;margin-bottom:2px;border-bottom:1px solid ${C.border};` },
                    h('span', { style: `font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;width:18px;` }, ''),
                    h('span', { style: `font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;padding:0 4px 0 20px;min-width:140px;` }, 'Code'),
                    h('span', { style: `font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;min-width:80px;margin:0 8px 0 4px;` }, 'Cost Center'),
                    h('span', { style: `font-size:10px;color:${C.muted};text-transform:uppercase;letter-spacing:.05em;margin:0 4px;` }, 'Pay type'),
                ));

                const favorites = codes.filter(c => c.favorite);
                const rest = codes.filter(c => !c.favorite).sort((a, b) => a.label.localeCompare(b.label));

                function moveCode(code, dir) {
                    const saved = loadSavedCodes();
                    const favs = saved.filter(s => s.favorite);
                    const others = saved.filter(s => !s.favorite);
                    const i = favs.findIndex(s => codeKey(s.value, s.payTypeId || '-1') === codeKey(code.value, code.payTypeId || '-1'));
                    const j = i + dir;
                    if (j < 0 || j >= favs.length) return;
                    [favs[i], favs[j]] = [favs[j], favs[i]];
                    saveCodes([...favs, ...others]);
                    renderList();
                    rebuildGrid();
                }

                function makeRow(code, isFav, favIdx, favTotal) {
                    const starBtn = h('button', {
                        type: 'button',
                        title: isFav ? 'Remove from favorites' : 'Add to favorites',
                        style: `background:none;border:none;cursor:pointer;font-size:16px;padding:0 4px 0 0;line-height:1;color:${C.orange};opacity:${isFav ? '1' : '0.25'};`,
                    }, '★');
                    starBtn.addEventListener('click', () => {
                        const saved = loadSavedCodes();
                        const idx = saved.findIndex(s => codeKey(s.value, s.payTypeId || '-1') === codeKey(code.value, code.payTypeId || '-1'));
                        const updated = { ...code, favorite: !isFav };
                        if (idx >= 0) saved[idx] = updated;
                        else saved.push(updated);
                        saveCodes(saved);
                        renderList();
                        rebuildGrid();
                    });

                    let payTypeEl;
                    if (payTypes.length > 0) {
                        payTypeEl = document.createElement('select');
                        payTypeEl.style.cssText = inputCss('cursor:pointer;font-size:11px;padding:1px 4px;margin:0 4px;');
                        const defOpt = document.createElement('option');
                        defOpt.value = '-1';
                        defOpt.textContent = 'Default';
                        payTypeEl.append(defOpt);
                        payTypes.forEach(pt => {
                            const o = document.createElement('option');
                            o.value = pt.id;
                            o.textContent = pt.label;
                            if (pt.id === code.payTypeId) o.selected = true;
                            payTypeEl.append(o);
                        });
                        payTypeEl.addEventListener('change', function () {
                            const saved = loadSavedCodes();
                            const idx = saved.findIndex(s => codeKey(s.value, s.payTypeId || '-1') === codeKey(code.value, code.payTypeId || '-1'));
                            const updated = { ...code, payTypeId: this.value };
                            if (idx >= 0) saved[idx] = updated;
                            else saved.push(updated);
                            saveCodes(saved);
                            rebuildGrid();
                        });
                    } else {
                        payTypeEl = h('span', { style: `font-size:11px;color:${C.muted};margin:0 4px;` }, '');
                    }

                    const delBtn = h('button', {
                        type: 'button',
                        title: 'Delete code',
                        style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:13px;padding:0 0 0 4px;line-height:1;opacity:0.5;`,
                    }, '×');
                    delBtn.addEventListener('click', () => {
                        const saved = loadSavedCodes();
                        saveCodes(saved.filter(s => codeKey(s.value, s.payTypeId || '-1') !== codeKey(code.value, code.payTypeId || '-1')));
                        renderList();
                        rebuildGrid();
                    });

                    const upBtn = h('button', {
                        type: 'button',
                        title: 'Move up',
                        style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:11px;padding:0 1px;line-height:1;opacity:${favIdx > 0 ? '0.7' : '0.2'};`,
                    }, '▲');
                    upBtn.addEventListener('click', () => moveCode(code, -1));

                    const downBtn = h('button', {
                        type: 'button',
                        title: 'Move down',
                        style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:11px;padding:0 1px;line-height:1;opacity:${favIdx < favTotal - 1 ? '0.7' : '0.2'};`,
                    }, '▼');
                    downBtn.addEventListener('click', () => moveCode(code, 1));

                    const reorderEl = isFav
                        ? h('span', { style: 'display:flex;flex-direction:column;margin-right:2px;' }, upBtn, downBtn)
                        : h('span', { style: 'width:18px;display:inline-block;' });

                    // Edit panel (label + labor value)
                    const labelSpan = h('span', { style: `font-size:11px;color:${C.text};min-width:140px;` }, baseLabel(code.label));
                    const ccSpanInline = h('span', { style: `font-size:10px;color:${C.muted};margin-left:5px;font-family:ui-monospace,monospace;` }, stripCostCenter(code.value));
                    const editBtn = h('button', { type: 'button', title: 'Edit', style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:14px;padding:0 4px;opacity:0.7;font-family:inherit;line-height:1;` }, '✎');

                    const editRow = h('div', { style: 'display:none;margin-top:3px;margin-left:18px;align-items:center;gap:6px;flex-wrap:wrap;' });
                    const editLabel = h('input', { type: 'text', value: code.label, style: inputCss('width:120px;font-size:11px;') });
                    const editValue = h('input', { type: 'text', value: code.value, style: inputCss('width:220px;font-size:11px;') });
                    const confirmBtn = h('button', { type: 'button', style: `background:${C.purple};color:#1e1e2e;border:none;border-radius:3px;font-size:11px;padding:2px 10px;cursor:pointer;font-family:inherit;font-weight:bold;` }, '✓ Save');
                    const cancelBtn = h('button', { type: 'button', style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:11px;padding:2px 6px;font-family:inherit;` }, 'Cancel');

                    editRow.append(
                        h('span', { style: `font-size:10px;color:${C.muted};` }, 'Label:'), editLabel,
                        h('span', { style: `font-size:10px;color:${C.muted};` }, 'Value:'), editValue,
                        confirmBtn, cancelBtn
                    );

                    editBtn.addEventListener('click', () => {
                        const open = editRow.style.display !== 'none' && editRow.style.display !== '';
                        editRow.style.display = open ? 'none' : 'flex';
                        if (!open) editLabel.focus();
                    });

                    const doEdit = () => {
                        const newLabel = editLabel.value.trim();
                        const newValue = editValue.value.trim();
                        if (newLabel && newValue) {
                            const saved = loadSavedCodes();
                            const idx = saved.findIndex(s => codeKey(s.value, s.payTypeId || '-1') === codeKey(code.value, code.payTypeId || '-1'));
                            const updated = { ...(idx >= 0 ? saved[idx] : code), label: newLabel, value: newValue };
                            if (idx >= 0) saved[idx] = updated; else saved.push(updated);
                            saveCodes(saved);
                            code.label = newLabel;
                            code.value = newValue;
                            labelSpan.textContent = baseLabel(newLabel);
                            ccSpanInline.textContent = stripCostCenter(newValue);
                            rebuildGrid();
                        }
                        editRow.style.display = 'none';
                    };
                    const doCancel = () => {
                        editLabel.value = code.label;
                        editValue.value = code.value;
                        editRow.style.display = 'none';
                    };
                    confirmBtn.addEventListener('click', doEdit);
                    cancelBtn.addEventListener('click', doCancel);
                    editLabel.addEventListener('keydown', e => { if (e.key === 'Enter') doEdit(); else if (e.key === 'Escape') doCancel(); });
                    editValue.addEventListener('keydown', e => { if (e.key === 'Enter') doEdit(); else if (e.key === 'Escape') doCancel(); });

                    const rowWrap = h('div', { style: 'padding:2px 0;' },
                        h('div', { style: 'display:flex;align-items:center;gap:2px;' },
                            reorderEl, starBtn,
                            labelSpan, ccSpanInline, editBtn,
                            payTypeEl, delBtn,
                        ),
                        editRow,
                    );
                    return rowWrap;
                }

                favorites.forEach((code, i) => body.append(makeRow(code, true, i, favorites.length)));

                if (favorites.length > 0 && rest.length > 0) {
                    body.append(h('div', { style: `border-top:1px solid ${C.border};margin:4px 0;` }));
                }

                rest.forEach(code => body.append(makeRow(code, false, 0, 0)));

                // New code form
                body.append(h('div', { style: `border-top:1px solid ${C.border};margin-top:6px;padding-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;` }, (() => {
                    const newLabel  = h('input', { type: 'text', placeholder: 'Label', style: inputCss('width:100px;') });
                    const newValue  = h('input', { type: 'text', placeholder: 'Labor level value', style: inputCss('width:220px;font-size:11px;') });
                    let newPayType;
                    if (payTypes.length > 0) {
                        newPayType = document.createElement('select');
                        newPayType.style.cssText = inputCss('cursor:pointer;');
                        const def = document.createElement('option');
                        def.value = '-1'; def.textContent = 'Default'; newPayType.append(def);
                        payTypes.forEach(pt => {
                            const o = document.createElement('option');
                            o.value = pt.id; o.textContent = pt.label; newPayType.append(o);
                        });
                    } else {
                        newPayType = h('input', { type: 'text', placeholder: 'Pay type ID', style: inputCss('width:90px;') });
                    }
                    const msg = h('span', { style: `font-size:11px;color:${C.muted};` });
                    const addBtn = h('button', { type: 'button', style: `background:${C.purple};color:#1e1e2e;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-weight:bold;font-size:12px;font-family:inherit;` }, '+ New code');
                    addBtn.addEventListener('click', () => {
                        const label = newLabel.value.trim();
                        const value = newValue.value.trim();
                        const payTypeId = newPayType.value || '-1';
                        if (!label || !value) { msg.textContent = 'Label and labor value required.'; msg.style.color = C.red; return; }
                        const saved = loadSavedCodes();
                        if (saved.some(s => codeKey(s.value, s.payTypeId || '-1') === codeKey(value, payTypeId))) {
                            msg.textContent = 'Already exists.'; msg.style.color = C.orange; return;
                        }
                        saved.push({ label, value, payTypeId });
                        saveCodes(saved);
                        newLabel.value = ''; newValue.value = '';
                        msg.textContent = `✓ "${label}" saved.`; msg.style.color = C.green;
                        setTimeout(() => { msg.textContent = ''; }, 3000);
                        renderList();
                        rebuildGrid();
                    });
                    return [newLabel, newValue, newPayType, addBtn, msg];
                })()));
            }

            const wrap = h('div', { style: `margin-top:4px;padding:4px 8px;background:${C.bgAlt};border-radius:6px;border:1px solid ${C.border};` }, toggle, body);
            return wrap;
        }

        // ── Autofill section ─────────────────────────────────────────

        function buildAutofillSection() {
            const codes = allJobCodes();
            if (codes.length === 0) return h('span', {});

            const sel = document.createElement('select');
            sel.style.cssText = inputCss('cursor:pointer;font-size:12px;');
            codes.forEach(jc => {
                const o = document.createElement('option');
                o.value = codeKey(jc.value, jc.payTypeId || '-1');
                o.textContent = (jc.favorite ? '★ ' : '') + displayLabel(jc);
                sel.append(o);
            });

            const hoursInput = h('input', {
                type: 'number', min: '0', max: '24', step: '0.25', value: '8',
                style: inputCss('width:50px;text-align:center;-moz-appearance:textfield;-webkit-appearance:none;'),
            });

            const fillBtn = h('button', {
                type: 'button',
                style: `background:${C.purple};color:#1e1e2e;border:none;border-radius:4px;padding:4px 14px;cursor:pointer;font-weight:bold;font-size:12px;font-family:inherit;`,
            }, 'Fill');

            fillBtn.addEventListener('click', () => {
                const selectedKey = sel.value;
                const hours = parseFloat(hoursInput.value);
                if (!selectedKey || isNaN(hours) || hours <= 0) return;

                let ci = codeList.findIndex(c => codeKey(c.value, c.payTypeId) === selectedKey);
                if (ci < 0) {
                    const prevLength = codeList.length;
                    addCodeRow(selectedKey);
                    if (codeList.length <= prevLength) return;
                    ci = prevLength;
                }

                sortedDays.forEach(({ di, date }) => {
                    if (isWeekend(date)) return;
                    const inp = panel.querySelector(`.pcty-cell[data-di="${di}"][data-ci="${ci}"]`);
                    if (inp && (!inp.value || parseFloat(inp.value) === 0)) {
                        inp.value = String(hours);
                    }
                });

                updateTotals();
            });

            return h('div', { style: `display:flex;align-items:center;gap:6px;margin-top:6px;padding:6px 8px;background:${C.bgAlt};border-radius:6px;border:1px solid ${C.border};` },
                h('span', { style: `font-size:11px;color:${C.muted};white-space:nowrap;text-transform:uppercase;letter-spacing:.05em;` }, 'Autofill:'),
                sel,
                hoursInput,
                h('span', { style: `font-size:11px;color:${C.muted};` }, 'hrs'),
                fillBtn,
            );
        }

        // ── Panel assembly ────────────────────────────────────────────

        const status = h('div', {
            id: 'pcty-status',
            style: `margin-top:8px;font-size:12px;color:${C.muted};min-height:16px;`
        });

        const saveButton = h('button', {
            type: 'button',
            id: 'pcty-save-btn',
            style: `background:${C.green};color:#1e1e2e;border:none;border-radius:5px;padding:7px 22px;cursor:pointer;font-weight:bold;font-size:13px;font-family:inherit;`,
            on: { click: () => submitTimesheet(state, panel, codeList, grid, sortedDays, maxEiByDi) }
        }, 'Save to Paylocity');

        const periodTotal = h('span', {
            id: 'pcty-period-total',
            style: `font-size:12px;color:${C.muted};`
        }, '0 / 0 hrs');

        const panel = h('div', {
            id: 'pcty-panel',
            style: `position:fixed;top:10px;right:10px;z-index:2147483647;
                    background:${C.bg};color:${C.text};border:1px solid ${C.border};
                    border-radius:10px;padding:16px;
                    width:calc(100vw - 32px);max-width:1400px;
                    max-height:90vh;overflow-y:auto;
                    font-family:ui-monospace,monospace;font-size:13px;
                    box-shadow:0 12px 40px rgba(0,0,0,0.6);`
        },
            // Header
            h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;' },
                h('strong', { style: `color:${C.purple};font-size:15px;` }, 'Paylocity Timesheet'),
                h('span', { style: `color:${C.muted};font-size:11px;` }, `${state.startDate} → ${state.endDate}`),
                h('span', { style: `color:${C.muted};font-size:11px;` }, '|  Period total: '),
                periodTotal,
                h('div', { style: 'flex:1' }),
                h('button', {
                    type: 'button',
                    style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:20px;padding:0 2px;line-height:1;`,
                    on: { click: () => panel.remove() }
                }, '×')
            ),
            // Scrollable table
            h('div', { style: 'overflow-x:auto;' }, tbl),
            // Add code row — dropdown of available codes
            h('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px;' }, (() => {
                const available = allJobCodes().filter(jc => !codeList.some(c => codeKey(c.value, c.payTypeId) === codeKey(jc.value, jc.payTypeId || '-1')));
                if (available.length === 0) return [];
                const sel = document.createElement('select');
                sel.style.cssText = inputCss('cursor:pointer;font-size:12px;');
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = '+ add code row…';
                placeholder.disabled = true;
                placeholder.selected = true;
                sel.append(placeholder);
                available.forEach(jc => {
                    const o = document.createElement('option');
                    o.value = codeKey(jc.value, jc.payTypeId || '-1');
                    o.textContent = (jc.favorite ? '★ ' : '') + displayLabel(jc);
                    sel.append(o);
                });
                sel.addEventListener('change', function () {
                    const key = this.value;
                    if (!key) return;
                    addCodeRow(key);
                    [...this.options].forEach(o => { if (o.value === key) o.remove(); });
                    this.value = '';
                });
                return [sel];
            })()),
            // Manage saved codes
            buildManageCodesSection(),
            // Autofill
            buildAutofillSection(),
            // Actions
            h('div', { style: 'display:flex;gap:8px;margin-top:8px;align-items:center;' },
                h('div', { style: 'flex:1' }),
                h('button', {
                    type: 'button',
                    style: `background:none;border:1px solid ${C.border};color:${C.muted};border-radius:5px;padding:7px 16px;cursor:pointer;font-size:12px;font-family:inherit;`,
                    on: { click: () => {
                        panel.querySelectorAll('.pcty-cell').forEach(inp => { inp.value = ''; });
                        updateTotals();
                    }}
                }, 'Clear All'),
                saveButton
            ),
            status
        );

        const spinnerStyle = document.createElement('style');
        spinnerStyle.textContent = '.pcty-cell::-webkit-inner-spin-button,.pcty-cell::-webkit-outer-spin-button{-webkit-appearance:none;margin:0;}';
        document.head.append(spinnerStyle);

        document.body.append(panel);
        updateTotals();

        // ── Keyboard navigation ───────────────────────────────────────
        function handlePanelKey(e) {
            if (e.key === 'Escape') {
                panel.remove();
                document.removeEventListener('keydown', handlePanelKey, true);
                return;
            }

            const active = document.activeElement;
            if (!active || !active.classList.contains('pcty-cell')) return;

            const di = +active.dataset.di;
            const ci = +active.dataset.ci;

            let targetDi = di, targetCi = ci;

            if (e.key === 'ArrowRight') {
                const nextDis = sortedDays.map(d => d.di).filter(d => d > di);
                if (nextDis.length) targetDi = nextDis[0];
            } else if (e.key === 'ArrowLeft') {
                const prevDis = sortedDays.map(d => d.di).filter(d => d < di);
                if (prevDis.length) targetDi = prevDis[prevDis.length - 1];
            } else if (e.key === 'ArrowDown') {
                const allCis = [...panel.querySelectorAll(`.pcty-cell[data-di="${di}"]`)].map(el => +el.dataset.ci);
                const nextCis = allCis.filter(c => c > ci);
                if (nextCis.length) targetCi = nextCis[0];
            } else if (e.key === 'ArrowUp') {
                const allCis = [...panel.querySelectorAll(`.pcty-cell[data-di="${di}"]`)].map(el => +el.dataset.ci);
                const prevCis = allCis.filter(c => c < ci);
                if (prevCis.length) targetCi = prevCis[prevCis.length - 1];
            } else {
                return;
            }

            const target = panel.querySelector(`.pcty-cell[data-di="${targetDi}"][data-ci="${targetCi}"]`);
            if (target) {
                e.preventDefault();
                target.focus();
                target.select();
            }
        }
        document.addEventListener('keydown', handlePanelKey, true);

        const origRemove = panel.remove.bind(panel);
        panel.remove = () => {
            document.removeEventListener('keydown', handlePanelKey, true);
            origRemove();
        };
    }

    // ── 4 PM reminder ────────────────────────────────────────────────

    function scheduleReminder() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(16, 0, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        const ms = target - now;
        setTimeout(() => {
            fireDailyReminder();
            // Re-schedule for tomorrow
            scheduleReminder();
        }, ms);
    }

    function fireDailyReminder() {
        // Skip weekends
        if ([0, 6].includes(new Date().getDay())) return;

        const state = parseTimesheetState();
        if (!state) return;

        const today = new Date().toISOString().split('T')[0];
        const todayDi = Object.entries(state.days).find(([, d]) => d.date === today)?.[0];
        if (todayDi == null) return;

        // Check if today already has hours — if so, skip the reminder
        const todayEntries = state.days[todayDi].entries;
        const alreadyFilled = Object.values(todayEntries).some(e => parseFloat(e.Duration) > 0);
        if (alreadyFilled) return;

        const notify = () => showQuickEntryModal(state, today);

        if (Notification.permission === 'granted') {
            const n = new Notification('Time to log your hours', {
                body: 'Click to fill in today\'s timesheet.',
                icon: 'https://webtime2.paylocity.com/favicon.ico',
            });
            n.addEventListener('click', () => { window.focus(); notify(); n.close(); });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => { if (p === 'granted') fireDailyReminder(); });
        }

        // Always show the in-page modal too
        notify();
    }

    function showQuickEntryModal(state, today) {
        document.getElementById('pcty-quick-modal')?.remove();

        const todayEntry = Object.values(state.days).find(d => d.date === today);
        if (!todayEntry) return;

        const codes = favoriteJobCodes();
        if (codes.length === 0) return;

        // Determine current hours for today per code
        const maxEiByDi = {};
        const sortedDays = Object.entries(state.days)
            .sort(([a], [b]) => +a - +b)
            .map(([idx, day]) => ({ di: +idx, ...day }));
        sortedDays.forEach(({ di, entries }) => {
            const eis = Object.keys(entries).map(Number);
            maxEiByDi[di] = eis.length > 0 ? Math.max(...eis) : -1;
        });

        function codeKey(value, payTypeId) { return value + '||' + (payTypeId || '-1'); }

        const d = new Date(today + 'T12:00:00');
        const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        const rows = codes.map(jc => {
            const existingEntry = Object.values(todayEntry.entries).find(e =>
                codeKey(e.LaborLevel, e.PayTypeId || '-1') === codeKey(jc.value, jc.payTypeId || '-1')
            );
            const currentHours = existingEntry ? parseFloat(existingEntry.Duration) || 0 : 0;

            const inp = h('input', {
                type: 'number', min: '0', max: '24', step: '0.25',
                value: currentHours > 0 ? String(currentHours) : '',
                placeholder: '0',
                style: inputCss('width:60px;text-align:center;-moz-appearance:textfield;-webkit-appearance:none;'),
            });
            inp.addEventListener('wheel', e => e.preventDefault(), { passive: false });

            const cc = stripCostCenter(jc.value);
            return {
                jc, inp,
                el: h('div', { style: 'display:flex;align-items:center;gap:8px;padding:4px 0;' },
                    h('span', { style: `font-size:13px;color:${C.text};flex:1;` }, baseLabel(jc.label),
                        cc ? h('span', { style: `font-size:10px;color:${C.muted};margin-left:5px;font-family:ui-monospace,monospace;` }, cc) : null
                    ),
                    inp,
                    h('span', { style: `font-size:11px;color:${C.muted};` }, 'hrs'),
                ),
            };
        });

        const totalSpan = h('span', { style: `font-size:12px;color:${C.muted};` }, '0 hrs');

        function updateModalTotal() {
            const sum = rows.reduce((acc, r) => acc + (parseFloat(r.inp.value) || 0), 0);
            totalSpan.textContent = `${sum % 1 === 0 ? sum : sum.toFixed(2)} hrs`;
            totalSpan.style.color = sum === 0 ? C.muted : sum < 8 ? C.orange : C.green;
        }
        rows.forEach(r => r.inp.addEventListener('input', updateModalTotal));

        const statusEl = h('div', { style: `font-size:12px;color:${C.muted};min-height:16px;margin-top:4px;` });

        const saveBtn = h('button', {
            type: 'button',
            style: `background:${C.green};color:#1e1e2e;border:none;border-radius:5px;padding:7px 22px;cursor:pointer;font-weight:bold;font-size:13px;font-family:inherit;`,
        }, 'Save');

        const dismissBtn = h('button', {
            type: 'button',
            style: `background:none;border:1px solid ${C.border};color:${C.muted};border-radius:5px;padding:7px 16px;cursor:pointer;font-size:12px;font-family:inherit;`,
        }, 'Dismiss');

        dismissBtn.addEventListener('click', () => modal.remove());

        saveBtn.addEventListener('click', () => {
            saveBtn.disabled = true;
            statusEl.style.color = C.muted;
            statusEl.textContent = 'Saving…';

            // Build a minimal codeList + grid for submitTimesheet
            const codeList = rows.map(r => ({
                label: r.jc.label,
                value: r.jc.value,
                payTypeId: r.jc.payTypeId || '-1',
            }));

            // Reconstruct grid from state for all days
            const grid = codeList.map(() => ({}));
            sortedDays.forEach(({ di, entries }) => {
                Object.entries(entries).forEach(([eiStr, entry]) => {
                    const ei = +eiStr;
                    const pid = entry.PayTypeId || '-1';
                    const key = codeKey(entry.LaborLevel, pid);
                    const ci = codeList.findIndex(c => codeKey(c.value, c.payTypeId) === key);
                    if (ci >= 0 && parseFloat(entry.Duration) > 0) {
                        grid[ci][di] = { hours: parseFloat(entry.Duration), existing: entry, ei };
                    }
                });
            });

            // Inject today's values into the grid so submitTimesheet picks them up.
            // We can't use .pcty-cell DOM lookups since the main panel may not be open,
            // so we temporarily create hidden inputs the submission loop will find.
            const di = +Object.entries(state.days).find(([, d]) => d.date === today)[0];
            const fakeInputs = rows.map((r, ci) => {
                const inp = document.createElement('input');
                inp.className = 'pcty-cell';
                inp.dataset.di = String(di);
                inp.dataset.ci = String(ci);
                inp.value = r.inp.value;
                inp.style.display = 'none';
                document.body.append(inp);
                return inp;
            });

            // submitTimesheet queries the panel for .pcty-cell and status/save elements,
            // so we pass a thin proxy object instead of the real panel.
            const proxyPanel = {
                querySelector: sel => {
                    if (sel === '#pcty-status') return statusEl;
                    if (sel === '#pcty-save-btn') return saveBtn;
                    return document.querySelector(sel);
                },
                querySelectorAll: sel => document.querySelectorAll(sel),
            };

            submitTimesheet(state, proxyPanel, codeList, grid, sortedDays, maxEiByDi);

            // Clean up fake inputs after a tick (submitTimesheet reads them synchronously)
            setTimeout(() => fakeInputs.forEach(i => i.remove()), 0);
        });

        const modal = h('div', {
            id: 'pcty-quick-modal',
            style: `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                    z-index:2147483647;background:${C.bg};color:${C.text};
                    border:1px solid ${C.border};border-radius:10px;padding:20px;
                    min-width:320px;max-width:420px;
                    font-family:ui-monospace,monospace;font-size:13px;
                    box-shadow:0 12px 40px rgba(0,0,0,0.7);`,
        },
            h('div', { style: 'display:flex;align-items:center;margin-bottom:12px;' },
                h('strong', { style: `color:${C.purple};font-size:14px;flex:1;` }, "Log today's hours"),
                h('span', { style: `font-size:11px;color:${C.muted};margin-right:8px;` }, dateLabel),
                h('button', {
                    type: 'button',
                    style: `background:none;border:none;color:${C.muted};cursor:pointer;font-size:20px;padding:0 2px;line-height:1;`,
                    on: { click: () => modal.remove() },
                }, '×'),
            ),
            ...rows.map(r => r.el),
            h('div', { style: `display:flex;align-items:center;gap:4px;margin-top:6px;padding-top:6px;border-top:1px solid ${C.border};` },
                h('span', { style: `font-size:11px;color:${C.muted};` }, 'Total:'),
                totalSpan,
                h('div', { style: 'flex:1' }),
                dismissBtn,
                saveBtn,
            ),
            statusEl,
        );

        document.body.append(modal);
        updateModalTotal();
        rows[0]?.inp.focus();
    }

    // ── Form submission ───────────────────────────────────────────────

    function submitTimesheet(state, panel, codeList, grid, sortedDays, maxEiByDi) {
        const status  = panel.querySelector('#pcty-status');
        const saveBtn = panel.querySelector('#pcty-save-btn');

        status.style.color = C.muted;
        status.textContent = 'Saving…';
        saveBtn.disabled = true;

        // Detect days that mix deletions with surviving entries. Even sending survivors
        // unchanged alongside deletedItems triggers a shift-conflict because the server
        // recalculates shift start times for entry updates before processing deletedItems.
        // Fix: two-POST strategy for mixed days:
        //   Phase 1 — wipe the entire day (delete ALL existing entries via deletedItems, no entry updates).
        //   Phase 2 — re-add only the survivors as brand-new entries (TimeSlicePreIdIn='0').
        const mixedDays = new Set();
        sortedDays.forEach(({ di, entries }) => {
            let hasDeletes = false, hasKeeps = false;
            const handled = new Set();
            codeList.forEach((code, ci) => {
                const inp = panel.querySelector(`.pcty-cell[data-di="${di}"][data-ci="${ci}"]`);
                const hours = inp ? (parseFloat(inp.value) || 0) : 0;
                const cellData = grid[ci] && grid[ci][di];
                const existing = cellData ? cellData.existing : null;
                if (cellData) handled.add(cellData.ei);
                if (existing && existing.TimeSlicePreIdIn && existing.TimeSlicePreIdIn !== '0') {
                    if (hours === 0) hasDeletes = true; else hasKeeps = true;
                } else if (hours > 0) hasKeeps = true;
            });
            Object.entries(entries || {}).forEach(([eiStr, entry]) => {
                if (!handled.has(+eiStr) && parseFloat(entry.Duration) > 0 &&
                    entry.TimeSlicePreIdIn && entry.TimeSlicePreIdIn !== '0') hasKeeps = true;
            });
            if (hasDeletes && hasKeeps) mixedDays.add(di);
        });

        function buildParams(phase1) {
            const params = new URLSearchParams();
            params.append('__RequestVerificationToken', state.token);

            // Mixed days in phase 2 have had all entries wiped, so start ei counters fresh.
            const eiCounters = {};
            sortedDays.forEach(({ di }) => {
                eiCounters[di] = (mixedDays.has(di) && !phase1) ? -1 : (maxEiByDi[di] != null ? maxEiByDi[di] : -1);
            });
            const deletedIds = [];

            sortedDays.forEach(({ di, date, entries }) => {
                params.append(`TimeSheet[${di}].Date`, date + 'T00:00:00');

                const isMixed = mixedDays.has(di);

                if (isMixed && phase1) {
                    // Wipe this day: delete every existing entry, send no entry updates.
                    // Consecutive shifts share a punch ID at the boundary (DRONE's Out =
                    // Meeting's In), so deduplicate to avoid "Unable to match all delete punches".
                    const seen = new Set();
                    Object.values(entries || {}).forEach(entry => {
                        if (entry.TimeSlicePreIdIn && entry.TimeSlicePreIdIn !== '0' && !seen.has(entry.TimeSlicePreIdIn)) {
                            seen.add(entry.TimeSlicePreIdIn);
                            deletedIds.push(entry.TimeSlicePreIdIn);
                        }
                        if (entry.TimeSlicePreIdOut && entry.TimeSlicePreIdOut !== '0' && !seen.has(entry.TimeSlicePreIdOut)) {
                            seen.add(entry.TimeSlicePreIdOut);
                            deletedIds.push(entry.TimeSlicePreIdOut);
                        }
                    });
                    return; // No Entries[n].* for this day in phase 1
                }

                const toSubmit = [];
                const handledEis = new Set();

                codeList.forEach((code, ci) => {
                    const inp = panel.querySelector(`.pcty-cell[data-di="${di}"][data-ci="${ci}"]`);
                    const hours = inp ? (parseFloat(inp.value) || 0) : 0;
                    const cellData = grid[ci] && grid[ci][di];
                    const existing = cellData ? cellData.existing : null;
                    const payTypeId = code.payTypeId && code.payTypeId !== '-1' ? code.payTypeId : (existing && existing.PayTypeId ? existing.PayTypeId : '-1');

                    if (cellData) handledEis.add(cellData.ei);

                    if (existing && existing.TimeSlicePreIdIn && existing.TimeSlicePreIdIn !== '0') {
                        if (hours === 0) {
                            if (!isMixed) {
                                // Non-mixed day: delete via deletedItems.
                                deletedIds.push(existing.TimeSlicePreIdIn);
                                if (existing.TimeSlicePreIdOut && existing.TimeSlicePreIdOut !== '0') {
                                    deletedIds.push(existing.TimeSlicePreIdOut);
                                }
                            }
                            // isMixed: day was fully wiped in phase 1 — nothing to do.
                        } else if (isMixed) {
                            // Mixed day phase 2: survivor becomes a fresh new entry.
                            eiCounters[di]++;
                            toSubmit.push({ ei: eiCounters[di], hours, labor: code.value, existing: {}, payTypeId });
                        } else {
                            toSubmit.push({ ei: cellData.ei, hours, labor: code.value, existing, payTypeId });
                        }
                    } else if (hours > 0) {
                        eiCounters[di]++;
                        toSubmit.push({ ei: eiCounters[di], hours, labor: code.value, existing: {}, payTypeId });
                    }
                });

                // Pass through unhandled existing entries unchanged.
                Object.entries(entries || {}).forEach(([eiStr, entry]) => {
                    const ei = +eiStr;
                    if (!handledEis.has(ei) && parseFloat(entry.Duration) > 0 &&
                        entry.TimeSlicePreIdIn && entry.TimeSlicePreIdIn !== '0') {
                        if (isMixed) {
                            eiCounters[di]++;
                            toSubmit.push({ ei: eiCounters[di], hours: parseFloat(entry.Duration), labor: entry.LaborLevel, existing: {}, payTypeId: entry.PayTypeId || '-1' });
                        } else {
                            toSubmit.push({ ei, hours: parseFloat(entry.Duration), labor: entry.LaborLevel, existing: entry, payTypeId: entry.PayTypeId || '-1' });
                        }
                    }
                });

                if (toSubmit.length === 0) {
                    const origEntries = Object.values(entries || {});
                    const hadRealEntries = origEntries.some(e =>
                        parseFloat(e.Duration) > 0 && e.TimeSlicePreIdIn && e.TimeSlicePreIdIn !== '0'
                    );
                    if (!hadRealEntries) {
                        const dummyLabor = (origEntries[0] && origEntries[0].LaborLevel) || state.dummyLabor;
                        params.append(`TimeSheet[${di}].Entries[0].PayTypeId`, '0');
                        params.append(`TimeSheet[${di}].Entries[0].Duration`, '0.00');
                        params.append(`TimeSheet[${di}].Entries[0].TimeSlicePreIdIn`, '0');
                        params.append(`TimeSheet[${di}].Entries[0].TimeSlicePreIdOut`, '');
                        params.append(`TimeSheet[${di}].Entries[0].SupervisorApproved`, 'False');
                        params.append(`TimeSheet[${di}].Entries[0].IsCallBack`, 'False');
                        params.append(`TimeSheet_${di}__Entries_0__LaborLevel.values`, dummyLabor);
                        params.append(`TimeSheet[${di}].Entries[0].Notes`, '');
                        params.append(`TimeSheet[${di}].Entries[0].IsNoteChanged`, '0');
                    }
                    return;
                }

                toSubmit.forEach(({ ei, hours, labor, existing, payTypeId }) => {
                    params.append(`TimeSheet[${di}].Entries[${ei}].PayTypeId`,         payTypeId || '-1');
                    params.append(`TimeSheet[${di}].Entries[${ei}].Duration`,           hours.toFixed(2));
                    params.append(`TimeSheet[${di}].Entries[${ei}].TimeSlicePreIdIn`,   existing.TimeSlicePreIdIn || '0');
                    params.append(`TimeSheet[${di}].Entries[${ei}].TimeSlicePreIdOut`,  existing.TimeSlicePreIdOut || '');
                    params.append(`TimeSheet[${di}].Entries[${ei}].SupervisorApproved`, existing.SupervisorApproved || 'False');
                    params.append(`TimeSheet[${di}].Entries[${ei}].IsCallBack`,         existing.IsCallBack || 'False');
                    params.append(`TimeSheet_${di}__Entries_${ei}__LaborLevel.values`,  labor);
                    params.append(`TimeSheet[${di}].Entries[${ei}].Notes`,              existing.Notes || '');
                    params.append(`TimeSheet[${di}].Entries[${ei}].IsNoteChanged`,      '0');
                });
            });

            params.append('DummyTimesheetEntry.PayTypeId',            '0');
            params.append('DummyTimesheetEntry.Duration',             '0.00');
            params.append('DummyTimesheetEntry.TimeSlicePreIdIn',     '0');
            params.append('DummyTimesheetEntry.TimeSlicePreIdOut',    '');
            params.append('DummyTimesheetEntry.SupervisorApproved',   'False');
            params.append('DummyTimesheetEntry.IsCallBack',           'False');
            params.append('DummyTimesheetEntry_LaborLevel.values',    state.dummyLabor);
            params.append('DummyTimesheetEntry.Notes',                '');
            params.append('DummyTimesheetEntry.IsNoteChanged',        '0');
            params.append('deletedItems',  deletedIds.join(','));
            params.append('StartDate',     state.startDate);
            params.append('EndDate',       state.endDate);
            return params;
        }

        function doPost(params) {
            return fetch('/WebTime/Employee/Timesheet/_Save', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: params.toString(),
                credentials: 'include',
            });
        }

        async function run() {
            if (mixedDays.size > 0) {
                status.textContent = 'Saving… (step 1/2)';
                const r1 = await doPost(buildParams(true));
                const text1 = await r1.text();
                let json1 = null;
                try { json1 = JSON.parse(text1); } catch (_) {}
                if (!r1.ok || (json1 && json1.type === 'error')) {
                    const msg = (json1 && json1.data) ? json1.data.join(' ') : `HTTP ${r1.status}`;
                    status.style.color = C.red;
                    status.textContent = '✗ ' + msg;
                    saveBtn.disabled = false;
                    return;
                }
                status.textContent = 'Saving… (step 2/2)';
            }

            const finalParams = buildParams(false);
            const bodyStr = finalParams.toString();
            const debugLines = ['deletedItems = ' + (finalParams.get('deletedItems') || '')];
            bodyStr.split('&').forEach(p => {
                const [k, v] = p.split('=').map(decodeURIComponent);
                if (k.includes('Entries') || k === 'deletedItems') debugLines.push(k + ' = ' + v);
            });
            localStorage.setItem('pcty_debug', debugLines.join('\n'));

            const r2 = await doPost(finalParams);
            const text2 = await r2.text();
            localStorage.setItem('pcty_response', text2);
            let json2 = null;
            try { json2 = JSON.parse(text2); } catch (_) {}

            if (!r2.ok || (json2 && json2.type === 'error')) {
                const msg = (json2 && json2.data) ? json2.data.join(' ') : `HTTP ${r2.status}`;
                status.style.color = C.red;
                status.textContent = '✗ ' + msg;
                saveBtn.disabled = false;
            } else {
                status.style.color = C.green;
                status.textContent = '✓ Saved! Reloading in 1.5s…';
                setTimeout(() => location.reload(), 1500);
            }
        }

        run().catch(e => {
            status.style.color = C.red;
            status.textContent = 'Network error: ' + e.message;
            saveBtn.disabled = false;
        });
    }

    // ── Bootstrap ─────────────────────────────────────────────────────

    function init() {
        if (document.getElementById('pcty-toggle-btn')) return;

        if (Notification.permission === 'default') Notification.requestPermission();
        scheduleReminder();

        const toggle = h('button', {
            id: 'pcty-toggle-btn',
            type: 'button',
            style: `position:fixed;bottom:24px;right:24px;z-index:2147483646;
                    background:${C.purple};color:#1e1e2e;border:none;
                    border-radius:22px;padding:9px 18px;cursor:pointer;
                    font-weight:bold;font-size:13px;font-family:ui-monospace,monospace;
                    box-shadow:0 4px 16px rgba(0,0,0,0.4);`,
            on: {
                click: () => {
                    if (document.getElementById('pcty-panel')) {
                        document.getElementById('pcty-panel').remove();
                        return;
                    }
                    tryOpenPanel();
                }
            }
        }, '⏱ Unsuckify Time Entry');

        function tryOpenPanel(attemptsLeft = 15) {
            const state = parseTimesheetState();
            if (state && Object.keys(state.days).length > 0) {
                buildUI(state);
                return;
            }
            if (attemptsLeft <= 0) {
                const allInputs = [...document.querySelectorAll('input[name]')].map(i => i.name);
                console.warn('[Paylocity Custom UI] Gave up waiting. Inputs found:', allInputs);
                alert('Timesheet still not loaded after 15 seconds. Open the browser console for details.');
                return;
            }
            toggle.textContent = `⏳ Loading… (${16 - attemptsLeft}s)`;
            setTimeout(() => {
                toggle.textContent = '⏱ Time Entry';
                tryOpenPanel(attemptsLeft - 1);
            }, 1000);
        }

        document.body.append(toggle);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
    } else {
        setTimeout(init, 800);
    }

})();
