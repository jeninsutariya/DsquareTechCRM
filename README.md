# DsquareTechCRM

## App Revenue Analytics dashboard (`dashboard/`)

A static web dashboard that reads app-wise revenue straight from an Excel file and calculates
every KPI, table and chart in the browser. No figures are hardcoded.

**Run it**

```bash
npm start          # serves dashboard/ at http://localhost:8080
```

On start the dashboard loads `dashboard/data/revenue.xlsx`. You can load any other `.xlsx` or `.csv`
file with **Load Excel file** or by dropping it on the page. If the page is opened straight from disk
(`file://`), the browser blocks the automatic load, so use the button.

**What it shows**

- KPI cards: total, today, yesterday, this week, this month, average daily revenue, total apps, active days
- App-wise table (sortable by any column): totals, period figures, average, highest and lowest day, active days
- Day-wise table: one column per app plus total daily revenue, newest date first
- Charts: total revenue by day, revenue by app, daily trend with a 7-day average, monthly trend, app comparison
- Filters: date range, apps, month, year. Every card, table and chart recalculates when a filter changes.
- App detail: totals, daily average, best and worst day, monthly revenue, trend chart, full day-wise history

**Input format**

Columns are detected by header name:

- Long format: `Date`, `App` (or `App ID`), and a revenue column such as `Ad Exchange revenue`
  (rate columns like eCPM, CTR and match rate are ignored).
- Wide format: `Date`, then one column per app. A `Total` column is ignored.

**Calculation rules**

- Overall total = sum of every app on every date. Daily total = sum of all apps on that date.
  App total = sum of that app across all dates.
- "Today" is the latest date in the filtered data by default (switchable to the calendar date).
  Weeks run Monday to "today"; the month runs from the 1st to "today".
- An active day has revenue above zero. Average daily revenue = total ÷ active days.
- Rows without a valid date (for example the report's `Total` row), empty or non-numeric revenue cells,
  and rows with no app name and zero revenue are skipped. Exact duplicate rows are counted once.
  Different rows for the same app and date are added together. The page footer lists what was skipped.

**Tests**

```bash
npm install
npm test
```
