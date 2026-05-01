# Paylocity Clean Timesheet — Setup Guide

A custom browser extension that replaces Paylocity's timesheet UI with a clean spreadsheet-style grid.

---

## Step 1: Install Tampermonkey

Tampermonkey is a browser extension that runs custom scripts on websites.

| Browser | Link |
|---------|------|
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) |
| Brave | Chrome Web Store link above (Brave supports Chrome extensions) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |

After installing, you should see the Tampermonkey icon (a black circle with two white dots) in your browser toolbar.

### Brave-specific: allow Tampermonkey on all sites

In Brave, Tampermonkey defaults to requiring manual approval per site. To fix this:

1. Go to `brave://extensions`
2. Find Tampermonkey and click **Details**
3. Under **Site access**, select **On all sites**

---

## Step 2: Install the script

1. Click the Tampermonkey icon in your toolbar
2. Select **Create a new script**
3. Select all the placeholder code in the editor and delete it
4. Paste the contents of `paylocity_timesheet.user.js` in its place
5. Press **Ctrl+S** (or **Cmd+S** on Mac) to save

---

## Step 3: Configure your job codes

Before using the script, you need to update the default job codes to match your own. Near the top of the script, find this section:

```js
const JOB_CODES_DEFAULT = [
    { label: 'DRONE (62/100/6006)',  value: '62/100/6006 DRONE////////////', payTypeId: '-1' },
    ...
];
```

Replace the entries with your own job codes. Each entry needs three fields:

- **`label`** — the display name shown in the UI (anything you like)
- **`value`** — the labor level string Paylocity uses internally
- **`payTypeId`** — the pay type ID number, or `'-1'` for the default work pay type

### How to find your labor level values and pay type IDs

The easiest way is to look at a real Paylocity timesheet entry in your browser's developer tools:

1. Log in to Paylocity and open your timesheet
2. Press **F12** to open developer tools, go to the **Network** tab
3. Enter some hours on a row and click **Save** in Paylocity's native UI
4. Find the `_Save` POST request in the network tab and click it
5. Look at the **Payload** — you'll see entries like:
   ```
   TimeSheet[0].Entries[0].PayTypeId = 4
   TimeSheet_0__Entries_0__LaborLevel.values = 86/150/////////////
   ```

For pay type IDs specifically, you can also inspect the pay type dropdown on the native timesheet row — each option's `value` attribute is the ID.

---

## Step 4: Use the timesheet

1. Go to `https://webtime2.paylocity.com/webtime/Employee/Timesheet`
2. Wait for the page to fully load (the native timesheet should appear)
3. Click the **⏱ Time Entry** button in the bottom-right corner of the page
4. The custom grid UI will open

---

## Using the UI

### Grid

- Rows = job codes, columns = days in the pay period
- Enter hours as decimals (e.g. `7.5` for 7.5 hours)
- Weekend columns are darker but still editable
- **Column totals** at the bottom are color-coded:
  - White = 0 hours
  - Orange = more than 0 but less than 8
  - Green = 8 or more
- **Period total** in the header shows total hours vs. target (8 × working days). Turns green when met.

### Adding and removing rows

- Use the **+ add code row…** dropdown below the grid to add a job code row
- Click **×** on a row label to remove it from the current view (does not delete the code)

### Saving

Click **Save to Paylocity** to submit. The page will reload automatically on success. If there's an error it will be shown in red — the most common cause is stale session IDs, which is fixed by closing the panel and reloading the page.

---

## Managing saved codes

Click **▶ Edit saved codes** below the grid to expand the code manager.

- **★** — toggle favorite. Favorited codes appear automatically every time you open the grid. Non-favorites only appear if they already have hours on the current timesheet.
- **✎** — edit the label or labor level value inline
- **Pay type dropdown** — change the pay type for the code
- **▲ / ▼** — reorder favorites (the order here is the row order in the grid)
- **×** — delete the code from your saved list
- **+ New code** — add a brand new code manually (you'll need the labor level value and pay type ID from Paylocity)

### Unrecognized codes

If Paylocity loads a timesheet entry with a labor code that isn't in your saved list, it will appear in the grid with an orange label and a **save?** button. Click **save?** to add it to your saved codes, then use **Edit saved codes** to rename it and set a pay type.

### Resetting to defaults

If you want to start fresh with the default codes, open the browser console on the Paylocity page and run:

```js
localStorage.removeItem('pcty_saved_codes')
```

Then reload the page. Your saved codes will be replaced with the defaults from the script.
