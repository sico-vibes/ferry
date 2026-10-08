import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process.mjs';
import { withChromium } from './chromium.mjs';

export async function unchanged(dir, fixture, paths) {
  for (const path of paths)
    assert.deepEqual(
      await readFile(join(dir, path)),
      await readFile(join(fixture, path)),
      `Protected file changed: ${path}`,
    );
}
export async function nodeTests(dir) {
  const result = await run(process.execPath, ['--test', 'test.mjs'], { cwd: dir });
  assert.equal(result.code, 0, `Tests failed: ${result.stdout}\n${result.stderr}`);
  assert.equal(result.timedOut, false, 'Tests timed out');
}
export async function texts(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await texts(path)));
    else result.push(await readFile(path, 'utf8'));
  }
  return result;
}
export async function checkMain(action) {
  try {
    const result = await action(process.argv[2]);
    if (result?.status === 'skipped') {
      console.log(result.reason);
      process.exitCode = 77;
    } else console.log('pass');
  } catch (error) {
    console.error(`fail: ${error.message}`);
    process.exitCode = 1;
  }
}

export async function responsive(dir) {
  return withChromium(async (page) => {
    for (const width of [375, 1280]) {
      await page.load(join(dir, 'index.html'), width);
      assert(
        await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),
        `Horizontal overflow at ${width}px`,
      );
      assert(
        await page.evaluate("document.querySelectorAll('.tile').length === 3"),
        'Expected three tiles',
      );
      assert(
        await page.evaluate(
          "[...document.querySelectorAll('.tile')].every(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right <= innerWidth)",
        ),
        'Tiles must fit viewport',
      );
    }
    assert.deepEqual(page.errors, [], 'Console errors');
  });
}

const dom = `
const visible = e => !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
const controls = () => [...document.querySelectorAll('button,a,[role=button],input[type=submit]')].filter(visible);
const click = word => { const e = controls().find(e => new RegExp(word,'i').test(e.textContent || e.value)); if(!e) throw Error('Missing control: '+word); e.click(); };
const form = () => [...document.forms].find(visible);
const fill = (title, body) => { const f=form(); if(!f) throw Error('Missing admin form'); const fields=[...f.querySelectorAll('input:not([type=hidden]):not([type=submit]),textarea')]; const titleField=fields.find(e=>/title/i.test(e.id+' '+e.name+' '+e.placeholder)) || fields[0]; const bodyField=fields.find(e=>e.tagName==='TEXTAREA'); if(!titleField || !bodyField) throw Error('Missing title/body fields'); for(const e of fields) { e.value=e===titleField?title:e===bodyField?body:'bench'; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); } f.requestSubmit(); };
const admin = () => { if(!form()) click('admin'); if(!form()) throw Error('Admin link did not reveal form'); };
const rowAction = (title, action) => { const button=controls().find(e => new RegExp('^'+action+'$','i').test(e.textContent.trim()) && (()=>{let p=e.parentElement; while(p && p!==document.body){ if(p.textContent.includes(title) && p.querySelectorAll('button').length<=4)return true; p=p.parentElement; } return false;})()); if(!button) throw Error('Missing '+action+' for '+title); button.click(); };
const hasTitle = title => [...document.querySelectorAll('h1,h2,h3,h4')].some(e=>visible(e)&&e.textContent.trim()===title);
`;
export async function blog(dir) {
  return withChromium(async (page) => {
    const evaluate = (code) => page.evaluate(`(()=>{${dom}\n${code}})()`);
    for (const width of [375, 1280]) {
      await page.load(join(dir, 'blog.html'), width);
      assert(
        await evaluate('return document.documentElement.scrollWidth <= innerWidth'),
        `Horizontal overflow at ${width}px`,
      );
      assert.equal(
        await evaluate(
          "return [...document.querySelectorAll('main h2,main h3,.card h2,.card h3')].filter(visible).length",
        ),
        3,
        'Expected three seeded post cards',
      );
      assert(
        await evaluate(
          "return [...document.querySelectorAll('[class*=excerpt],.card p,article p')].filter(visible).every(e=>!e.textContent.includes('#'))",
        ),
        'Card excerpt contains raw #',
      );
    }
    await evaluate(
      'admin(); fill("Bench Added", "# Bench heading\\nA paragraph <img src=x onerror=window.benchXss=1>");',
    );
    await page.reload();
    assert(
      await evaluate('return hasTitle("Bench Added")'),
      'Added post did not persist across reload',
    );
    assert(
      await evaluate(
        "return [...document.querySelectorAll('[class*=excerpt],.card p,article p')].filter(visible).every(e=>!e.textContent.includes('#'))",
      ),
      'Added Markdown post exposes raw # in its card excerpt',
    );
    await evaluate(
      'admin(); rowAction("Bench Added","edit"); fill("Bench Edited", "## Edited heading\\nEdited paragraph");',
    );
    await page.reload();
    assert(
      await evaluate('return hasTitle("Bench Edited") && !hasTitle("Bench Added")'),
      'Edited post did not persist across reload',
    );
    await evaluate('admin(); rowAction("Bench Edited","delete");');
    await page.reload();
    assert(
      await evaluate('return !hasTitle("Bench Edited")'),
      'Deleted post returned after reload',
    );
    assert.deepEqual(page.errors, [], 'Console errors');
  });
}
