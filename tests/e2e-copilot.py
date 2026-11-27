# Browser test of the copilot loop with a scripted Gemini (no API key needed).
# Run: node dev-server.mjs (PORT=3077) then python3 tests/e2e-copilot.py
import asyncio, json
from playwright.async_api import async_playwright
URL = 'http://localhost:3077/'
script = []   # queued model replies
seen = []     # request bodies the browser sent
def fc(name, args): return {'role': 'model', 'parts': [{'functionCall': {'name': name, 'args': args}, 'thoughtSignature': 'sig-' + name}]}
def tx(t): return {'role': 'model', 'parts': [{'text': t}]}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 1000})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def cfg(route): await route.fulfill(json={'gemini_configured': True, 'gemini_model': 'mock', 'env': {}})
        async def chat(route):
            body = json.loads(route.request.post_data); seen.append(body)
            await route.fulfill(json={'ok': True, 'model': 'mock', 'content': script.pop(0)})
        await pg.route('**/api/config', cfg); await pg.route('**/api/chat', chat)
        await pg.goto(URL, wait_until='networkidle'); await pg.evaluate('localStorage.clear()'); await pg.reload(wait_until='networkidle')
        await pg.click('#copilotBtn')
        # Q1: cash question -> tool -> honest answer
        script.extend([fc('get_snapshot', {}), tx('Cash collected is not in the data: there are no payment records. Confirmed value is ₹22.4L (₹20.0L cash-type, ₹2.4L in-kind) as of 2025-04-20.')])
        await pg.fill('#cpText', 'How much cash have we collected?'); await pg.press('#cpText', 'Enter')
        await pg.wait_for_selector('.msg.bot:nth-of-type(3)', timeout=8000)
        fr = seen[1]['contents'][-1]['parts'][0]['functionResponse']
        assert fr['name'] == 'get_snapshot' and fr['response']['result']['cash_collected_inr'] is None and fr['response']['result']['confirmed_value_inr'] == 2240000, fr
        assert seen[1]['contents'][-2]['parts'][0].get('thoughtSignature') == 'sig-get_snapshot', 'thought signature not echoed'
        assert any(t['name'] == 'propose_task' for t in seen[0]['tools']) and 'NO payment records' in seen[0]['system']
        print('PASS Q1 tool round-trip, signature echoed, system prompt carries data limits')
        # Q2: follow-up uses history; propose task -> confirm -> created
        script.extend([fc('list_brands', {'qualification_status': 'qualified', 'has_opportunity': False}),
                       fc('propose_task', {'title': 'Send proposals to 18 qualified brands with no deal', 'owner': 'Nisha Rao', 'notes': '18 qualified brands never got an opportunity; 12 from warm channels.'}),
                       tx('Done: the task is created and assigned to Nisha Rao.')])
        await pg.fill('#cpText', 'Create a task to follow up on qualified brands with no deal'); await pg.press('#cpText', 'Enter')
        await pg.wait_for_selector('.confirm .btn.primary', timeout=8000)
        assert len(seen[2]['contents']) > 4, 'history not carried into follow-up'
        await pg.screenshot(path='/home/claude/work/cp_confirm.png')
        await pg.click('.confirm .btn.primary')
        await pg.wait_for_function('document.querySelectorAll(".msg.bot").length >= 3', timeout=8000)
        last = seen[-1]['contents'][-1]['parts'][0]['functionResponse']
        assert last['name'] == 'propose_task' and last['response']['result']['status'] == 'created', last
        await pg.click('nav button[data-view="tasks"]'); await pg.wait_for_timeout(300)
        txt = await pg.inner_text('#view'); assert 'Send proposals to 18 qualified brands' in txt and 'copilot' in txt
        print('PASS Q2 follow-up keeps history; task proposed, confirmed by click, saved and shown in Tasks')
        # Q3: decline path
        script.extend([fc('propose_task', {'title': 'Stop Brand Discovery Email', 'notes': '224 attempts, 0 wins'}), tx('Okay, I did not create it.')])
        await pg.fill('#cpText', 'add a task to stop cold email'); await pg.press('#cpText', 'Enter')
        await pg.wait_for_selector('.confirm .btn:not(.primary)', timeout=8000)
        await pg.click('.confirm .btn:not(.primary)'); await pg.wait_for_timeout(500)
        assert seen[-1]['contents'][-1]['parts'][0]['functionResponse']['response']['result']['status'] == 'declined_by_user'
        print('PASS Q3 decline is reported back to the model; nothing saved')
        # edit a deal -> numbers move
        await pg.click('nav button[data-view="pipeline"]'); await pg.wait_for_timeout(300)
        await pg.select_option('select[data-f="pipe.stage"]', 'negotiating'); await pg.wait_for_timeout(300)
        await pg.click('[data-edit-opp]'); await pg.select_option('#modalCard select[name=stage]', 'partner_confirmed'); await pg.click('#modalCard .btn.primary'); await pg.wait_for_timeout(500)
        await pg.click('nav button[data-view="overview"]'); await pg.wait_for_timeout(500)
        k = await pg.inner_text('.kpis'); assert '25' in k, k
        await pg.fill('#asOf', '2025-04-01'); await pg.dispatch_event('#asOf', 'change'); await pg.wait_for_timeout(500)
        k2 = await pg.inner_text('.kpis'); assert '23' in k2, k2
        print('PASS deal edit appends a version dated as-of: 25 confirmed on 20 Apr, still 23 on 1 Apr')
        await pg.screenshot(path='/home/claude/work/cp_after.png')
        print('page errors:', errs or 'none')
        await b.close()
asyncio.run(main())
