const ALARM_NAME = 'pcty-daily-reminder';
const PAYLOCITY_URL = 'https://webtime2.paylocity.com/';
const TIMESHEET_URL = 'https://webtime2.paylocity.com/WebTime/Employee/Timesheet';

const DEFAULT_SETTINGS = { enabled: true, hour: 16, minute: 0 };

async function getSettings() {
    const s = await chrome.storage.local.get(DEFAULT_SETTINGS);
    return s;
}

async function scheduleAlarm() {
    await chrome.alarms.clear(ALARM_NAME);
    const { enabled, hour, minute } = await getSettings();
    if (!enabled) return;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    // Skip ahead past weekends
    while ([0, 6].includes(target.getDay())) {
        target.setDate(target.getDate() + 1);
    }

    chrome.alarms.create(ALARM_NAME, { when: target.getTime() });
}

chrome.runtime.onInstalled.addListener(scheduleAlarm);
chrome.runtime.onStartup.addListener(scheduleAlarm);

// Re-schedule when settings change (triggered by the popup saving).
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.enabled || changes.hour || changes.minute)) {
        scheduleAlarm();
    }
});

async function triggerReminder() {
    // Set the flag first — the content script will pick it up regardless of
    // how many redirects happen (login → home → timesheet).
    await chrome.storage.local.set({ pendingReminder: Date.now() });

    const tabs = await chrome.tabs.query({ url: PAYLOCITY_URL + '*' });
    if (tabs.length > 0) {
        const tab = tabs[0];
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        // If already on the timesheet, poke it directly; otherwise the content
        // script will navigate there on its own when it sees the flag.
    } else {
        chrome.tabs.create({ url: TIMESHEET_URL });
    }
}

chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name !== ALARM_NAME) return;
    scheduleAlarm();
    await triggerReminder();
    chrome.notifications.create('pcty-reminder', {
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Time to log your hours',
        message: "It's time — fill in today's timesheet.",
        priority: 2,
    });
});

chrome.notifications.onClicked.addListener(async notifId => {
    if (notifId !== 'pcty-reminder') return;
    chrome.notifications.clear(notifId);
    await triggerReminder();
});
