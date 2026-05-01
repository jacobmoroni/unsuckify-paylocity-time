const toggle   = document.getElementById('enabled-toggle');
const enabledLabel = document.getElementById('enabled-label');
const hourEl   = document.getElementById('hour');
const minuteEl = document.getElementById('minute');
const saveBtn  = document.getElementById('save-btn');
const statusEl = document.getElementById('status');
const nextEl   = document.getElementById('next-alarm');

function pad(n) { return String(n).padStart(2, '0'); }

function fmt12(h, m) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${pad(m)} ${ampm}`;
}

function updateEnabledLabel() {
    enabledLabel.textContent = toggle.checked ? 'On' : 'Off';
    enabledLabel.style.color = toggle.checked ? '#a6e3a1' : '#6c7086';
    hourEl.disabled = !toggle.checked;
    minuteEl.disabled = !toggle.checked;
}

toggle.addEventListener('change', updateEnabledLabel);

async function refreshNextAlarm() {
    const alarm = await chrome.alarms.get('pcty-daily-reminder');
    if (alarm) {
        const d = new Date(alarm.scheduledTime);
        nextEl.textContent = `Next: ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${fmt12(d.getHours(), d.getMinutes())}`;
    } else {
        nextEl.textContent = 'Reminder is off.';
    }
}

// Load saved settings on open.
chrome.storage.local.get({ enabled: true, hour: 16, minute: 0 }, ({ enabled, hour, minute }) => {
    toggle.checked = enabled;
    hourEl.value = hour;
    minuteEl.value = minute;
    updateEnabledLabel();
    refreshNextAlarm();
});

document.getElementById('log-btn').addEventListener('click', async () => {
    const PAYLOCITY_URL = 'https://webtime2.paylocity.com/';
    const TIMESHEET_URL = 'https://webtime2.paylocity.com/WebTime/Employee/Timesheet';

    const tabs = await chrome.tabs.query({ url: PAYLOCITY_URL + '*' });
    if (tabs.length > 0) {
        const tab = tabs[0];
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        // Direct message is instant for an already-open tab. Storage flag below
        // is the fallback for when the content script needs to navigate first.
        chrome.tabs.sendMessage(tab.id, { type: 'pcty-show-reminder', force: true }).catch(() => {});
    } else {
        chrome.tabs.create({ url: TIMESHEET_URL });
    }
    await chrome.storage.local.set({ pendingReminder: Date.now(), pendingReminderForce: true });
    window.close();
});

saveBtn.addEventListener('click', () => {
    const hour   = Math.max(0, Math.min(23, parseInt(hourEl.value)   || 0));
    const minute = Math.max(0, Math.min(59, parseInt(minuteEl.value) || 0));
    const enabled = toggle.checked;

    // Normalise displayed values after clamping
    hourEl.value   = hour;
    minuteEl.value = minute;

    chrome.storage.local.set({ enabled, hour, minute }, () => {
        statusEl.style.color = '#a6e3a1';
        statusEl.textContent = enabled
            ? `✓ Set for ${fmt12(hour, minute)} weekdays`
            : '✓ Reminder disabled';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
        // Background reschedules via storage.onChanged; poll briefly for the updated alarm.
        setTimeout(refreshNextAlarm, 400);
    });
});
