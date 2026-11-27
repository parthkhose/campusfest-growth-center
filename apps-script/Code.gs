/**
 * Growth Center <-> Google Sheet bridge.
 * Paste into Extensions > Apps Script on the sheet (one copy per sheet: the 2025 sample and the 2026 tracker).
 * Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone". Copy the /exec URL into the dashboard.
 * Optional: Project Settings > Script properties > add WRITE_TOKEN; then put the same token in the dashboard
 * (Connections panel) or in Vercel's WRITE_TOKEN env var. Reads stay open; writes require the token when it is set.
 *
 * GET  -> { ok, spreadsheet, fetched_at, tabs: { <tab>: [ {header: value, ...}, ... ] } }   (all tabs except "Read me")
 * POST -> { action: "append", tab, row: {...} }  or  { action: "update", tab, key, id, patch: {...} }
 */
var SKIP_TABS = ['Read me'];
var APPENDABLE = ['App_Tasks', 'App_Edits', 'Tasks', 'Deals', 'Payments', 'Creators', 'InKind', 'Signals'];

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm:ss'+05:30'");
  return v;
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (SKIP_TABS.indexOf(name) >= 0) return;
    var values = sh.getDataRange().getValues();
    if (!values.length) { out[name] = []; return; }
    var head = values[0].map(String);
    out[name] = values.slice(1).filter(function (r) {
      return r.some(function (c) { return c !== '' && c !== null; });
    }).map(function (r) {
      var o = {};
      head.forEach(function (h, i) { if (h) o[h] = cell_(r[i]); });
      return o;
    });
  });
  return json_({ ok: true, spreadsheet: ss.getName(), fetched_at: new Date().toISOString(), tabs: out });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('WRITE_TOKEN');
    if (token && body.token !== token) return json_({ ok: false, error: 'Invalid write token.' });
    if (APPENDABLE.indexOf(body.tab) < 0) return json_({ ok: false, error: 'Tab not writable: ' + body.tab });
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(body.tab);
    if (!sh) return json_({ ok: false, error: 'No tab named ' + body.tab });
    var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);

    if (body.action === 'append') {
      var row = head.map(function (h) { var v = body.row[h]; return v === undefined || v === null ? '' : v; });
      sh.appendRow(row);
      return json_({ ok: true, action: 'append', tab: body.tab, row_number: sh.getLastRow() });
    }
    if (body.action === 'update') {
      var keyCol = head.indexOf(body.key);
      if (keyCol < 0) return json_({ ok: false, error: 'No column ' + body.key });
      var data = sh.getDataRange().getValues();
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][keyCol]) === String(body.id)) {
          Object.keys(body.patch || {}).forEach(function (k) {
            var c = head.indexOf(k);
            if (c >= 0) sh.getRange(r + 1, c + 1).setValue(body.patch[k]);
          });
          var lu = head.indexOf('last_updated');
          if (lu >= 0) sh.getRange(r + 1, lu + 1).setValue(Utilities.formatDate(new Date(), 'Asia/Kolkata', "yyyy-MM-dd'T'HH:mm:ss'+05:30'"));
          return json_({ ok: true, action: 'update', tab: body.tab, row_number: r + 1 });
        }
      }
      return json_({ ok: false, error: 'No row with ' + body.key + ' = ' + body.id });
    }
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
