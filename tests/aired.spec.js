const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { watchConsole, openSection, pickChat, openProfilePage } = require('./helpers');
// The shared Released card (records.js openReleasedDetails): the title card in #released-modal
const toMine=async(page)=>{await page.locator('.section.active [data-admin-profile] a').click();await openSection(page,'my-aired');};
const toAdmin=async(page)=>{await openProfilePage(page,'my-profile');await page.locator('#my-profile-body [data-action="view-admin"]').click();};
const publicCard=(page)=>page.locator('#released-body').evaluate(el=>{const c=el.cloneNode(true);c.querySelectorAll('#released-people,.tc-footer,.sheet-error').forEach(node=>node.remove());c.querySelectorAll('[style]').forEach(node=>node.removeAttribute('style'));return c.innerHTML;});
watchConsole({ignore:/status of (?:500|503)|Fetch error: Error: Temporary failure/});

test('personal Released uses the shared lists, years and title card without admin requests', async ({page}) => {
    const requests=[];
    page.on('request',r=>{if(r.url().includes('/api/'))requests.push(new URL(r.url()).pathname)});
    const panel=await mockPanel(page,{role:'user'});
    await openSection(page,'my-aired');
    const body=page.locator('#my-aired-body');
    await expect(body.locator('.history-grid')).toBeVisible();
    await expect(page.locator('#my-aired-series .row-name')).toHaveText('Одни из нас');
    await expect(page.locator('#my-aired-films .row-name')).toHaveText('Released film');
    // No Kinopoisk badge on the rows: it lives in the card
    await expect(body.locator('.kp-link')).toHaveCount(0);
    await page.locator('#my-aired-films .history-open').click();
    await expect(page.locator('#released-title')).toHaveText('Released film');
    await expect(page.locator('#released-modal').getByRole('link',{name:'Open on Kinopoisk'})).toHaveAttribute('href','https://www.kinopoisk.ru/film/9/');
    await expect(page.locator('#released-people')).toHaveCount(0);
    await page.locator('#released-modal .sheet-close').click();
    await page.locator('#my-aired-years button').filter({hasText:'2025'}).click();
    await expect(page.locator('#my-aired-films .history-empty')).toContainText('2025');
    await expect(page.locator('#my-aired-series')).toContainText('Season 1');
    await pickChat(page,'my-aired','Киноклуб');
    await expect(body).toContainText('Group release');
    await expect(body).not.toContainText('Одни из нас');
    expect(requests.some(p=>/^\/api\/(history|series|movie|kinopoisk)(\/|$)/.test(p))).toBe(false);
    expect(panel.account.sent.every(r=>r.path.startsWith('/api/account/'))).toBe(true);
});

for(const kind of ['series','films'])test(`personal Released ${kind} opens the shared title card`,async({page})=>{
    await mockPanel(page,{role:'user'});
    await openSection(page,'my-aired');
    await page.locator(`#my-aired-${kind} .history-open`).click();
    const card=page.locator('#released-modal');
    await expect(card).toBeVisible();
    await expect(card.locator('.tc-rating')).toContainText(kind==='series'?'8.6':'7.4');
    await expect(card.locator(kind==='series'?'.tc-premieres':'.tc-date')).toContainText(kind==='series'?'28 Dec':'26 Feb 2026');
    await expect(card.locator('.mine-modes')).toHaveCount(0);
    await expect(card.getByRole('link',{name:'Watch on SSPoisk'})).toBeVisible();
    await expect(card.getByRole('button',{name:'Unfollow',exact:true})).toBeVisible();
    await card.getByRole('button',{name:'Show more'}).click();
    await expect(card.locator('.tc-overview')).toHaveClass(/is-open/);
    await card.getByRole('button',{name:'Show less'}).click();
    await expect(card.locator('.tc-overview')).not.toHaveClass(/is-open/);
});

test('admin and personal Released share identical row markup and independent pager state',async({page})=>{
    const data={years:[2026],year:2026,series:Array.from({length:23},(_,i)=>({tmdbId:`tv_${i}`,title:`Show ${i}`,seasons:[2],genres:['drama'],poster:null,kinopoiskUrl:'https://www.kinopoisk.ru/'})),films:[]};
    const panel=await mockPanel(page,{history:()=>data});
    panel.account.aired=()=>data;
    await openSection(page,'history');
    await expect(page.locator('#history-series .history-open')).toHaveCount(10);
    const adminRow=await page.locator('#history-series .history-item').first().evaluate(el=>el.outerHTML);
    await page.locator('#history-series-pager [data-step="1"]').click();
    await expect(page.locator('#history-series-pager .pager-info')).toHaveText('11–20 of 23');
    await toMine(page);
    await expect(page.locator('#my-aired-series-pager .pager-info')).toHaveText('1–10 of 23');
    expect(await page.locator('#my-aired-series .history-item').first().evaluate(el=>el.outerHTML)).toBe(adminRow);
    await page.locator('#my-aired-series-pager [data-step="1"]').click();
    await expect(page.locator('#my-aired-series-pager .pager-info')).toHaveText('11–20 of 23');
    await toAdmin(page);
    await expect(page.locator('#history-series-pager .pager-info')).toHaveText('11–20 of 23');
});

test('a late answer for the old chat cannot replace the newly selected chat',async({page})=>{
    const panel=await mockPanel(page,{role:'user'});
    let release;
    const held=new Promise(resolve=>{release=resolve});
    panel.account.aired=async(year,chatId)=>{
        if(year===2025)await held;
        return {years:[2026,2025],year,series:[{tmdbId:'tv_1',title:chatId==='-100'?'New group':'Old private',seasons:[1],genres:[],kinopoiskUrl:'https://www.kinopoisk.ru/'}],films:[]};
    };
    await openSection(page,'my-aired');
    await page.locator('#my-aired-years button').filter({hasText:'2025'}).click();
    try {
        await pickChat(page,'my-aired','Киноклуб');
        await expect(page.locator('#my-aired-series')).toContainText('New group');
    }finally{release()}
    await expect(page.locator('#my-aired-series')).not.toContainText('Old private');
    await expect(page.locator('#my-aired-years .active')).toHaveText('2026');
});

test('a failed personal refresh preserves the shared list and working page-size control',async({page})=>{
    const panel=await mockPanel(page,{role:'user'});
    panel.account.aired=()=>({years:[2026],year:2026,series:Array.from({length:23},(_,i)=>({tmdbId:`tv_${i}`,title:`Show ${i}`,seasons:[1],genres:[],kinopoiskUrl:'https://www.kinopoisk.ru/'})),films:[]});
    await openSection(page,'my-aired');
    await expect(page.locator('#my-aired-series .history-open')).toHaveCount(10);
    panel.account.aired=()=>({status:503,body:{error:'Temporary failure'}});
    await openSection(page,'my-calendar');
    const failed=page.waitForResponse(r=>r.url().includes('/aired')&&r.status()===503);
    await openSection(page,'my-aired');
    await failed;
    await expect(page.locator('#my-aired-series .history-open')).toHaveCount(10);
    await page.locator('#my-aired-series-pager .custom-select-trigger').click();
    await page.locator('.custom-select-option',{hasText:'25'}).click();
    await expect(page.locator('#my-aired-series .history-open')).toHaveCount(23);
});

test('both Released scopes render the same public card even when admin private details differ',async({page})=>{
    const data={years:[2026],year:2026,series:[{tmdbId:'tv_66732',title:'Shared title',rating:8.6,seasonCount:5,overview:'Shared description',seasons:[2],seasonPremieres:[{season:2,date:'2025-12-28'}],genres:['drama'],poster:null,kinopoiskUrl:'https://www.kinopoisk.ru/series/1/'}],films:[]};
    const panel=await mockPanel(page,{history:()=>data});panel.account.aired=()=>data;
    await openSection(page,'history');await page.locator('#history-series .history-open').click();
    await expect(page.locator('#released-title')).toHaveText('Shared title');
    await expect(page.locator('#released-people')).toBeVisible();
    const adminParts=await publicCard(page);
    await page.locator('#released-modal .sheet-close').click();
    await toMine(page);
    await page.locator('#my-aired-series .history-open').click();
    await expect(page.locator('#released-title')).toHaveText('Shared title');
    expect(await publicCard(page)).toEqual(adminParts);
    await expect(page.locator('#released-people')).toHaveCount(0);
});

test('private admin enrichment failure does not hide the shared public card',async({page})=>{
    await mockPanel(page,{failing:['/api/series/tv_66732']});
    await openSection(page,'history');await page.locator('#history-series .history-open').first().click();
    await expect(page.locator('#released-title')).toHaveText('Stranger Things');
    await expect(page.locator('#released-people')).toContainText('Chat information unavailable');
});

test('Released deep link survives reload',async({page})=>{
    await mockPanel(page,{role:'user',path:'/#my-aired'});
    await expect(page.locator('#my-aired-series .history-open')).toHaveCount(1);
    await page.reload();
    await expect(page.locator('#my-aired-section')).toHaveClass(/active/);
    await expect(page.locator('#my-aired-series .history-open')).toHaveCount(1);
});

test('the Account tab offers a reachable Admin panel row on tablets',async({page,isMobile})=>{
    test.skip(isMobile,'one explicit tablet viewport');
    await page.setViewportSize({width:800,height:900});
    await mockPanel(page,{path:'/#my-aired'});
    await openProfilePage(page,'my-profile');
    const admin=page.locator('#my-profile-body [data-action="view-admin"]');
    await expect(admin).toBeVisible();
    const box=await admin.boundingBox();expect(box.y+box.height).toBeLessThanOrEqual(900);
    await admin.click();await expect(page.locator('#dashboard-section')).toHaveClass(/active/);
});

test('a Released view with no years hides the empty year strip on every width',async({page})=>{
    const panel=await mockPanel(page,{role:'user'});
    panel.account.aired=()=>({years:[],year:null,series:[],films:[]});
    await openSection(page,'my-aired');
    await expect(page.locator('#my-aired-films .history-empty')).toContainText('Nothing yet');
    await expect(page.locator('#my-aired-years')).toBeHidden();
});
