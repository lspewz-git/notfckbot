const { test, expect } = require('@playwright/test');
const { mockPanel } = require('./mock-panel');
const { openSection, openProfilePage, watchConsole } = require('./helpers');

watchConsole({ignore:/Failed to load resource.*503/});
const OVERVIEW = 'A long description with enough space to read every detail. '.repeat(80);
const WATCH = { kind: 'watch', label: 'Watch on SSPoisk', url: 'https://example.test/watch' };

async function openCard(page, tab, options = {}) {
    const panel = await mockPanel(page, { role: 'user' });
    panel.account.series[0].overview = OVERVIEW;
    panel.account.series[0].links.push(WATCH);
    panel.account.calendar.items.forEach(item => { item.overview = OVERVIEW; item.links = [...(item.links || []), WATCH]; });
    if (options.seasons || tab==='my-aired') panel.account.aired = () => ({
        years: [2026], year: 2026,
        series: [{ tmdbId: 'tv_100', title: 'Shared show', overview: OVERVIEW, seasons: Array.from({length:options.seasons||1},(_,i)=>i+1), seasonPremieres: Array.from({length:options.seasons||1},(_,i)=>({season:i+1,date:'2026-01-12'})), links:[WATCH], kinopoiskUrl:'https://www.kinopoisk.ru/series/1/' }], films: []
    });
    await openSection(page, tab);
    const row = tab === 'my-subs' ? '#my-subs-body .title-row' : tab === 'my-aired' ? '#my-aired-series .history-open' : '#my-calendar-body .cal-row';
    await page.locator(row).first().click();
    const card = page.locator(tab === 'my-aired' ? '#released-body' : '#mine-card-body');
    await card.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    return {panel, card};
}

for (const tab of ['my-calendar','my-aired','my-subs']) {
    test(`${tab} uses shared scroll body, bottom actions and inline description link`, async ({page}) => {
        const {card} = await openCard(page,tab);
        await expect(card.locator('.tc-scroll')).toHaveCount(1);
        await expect(card.locator('.tc-footer .tc-link')).toBeVisible();
        await expect(card.locator('.tc-footer').getByRole('link',{name:'Watch on SSPoisk'})).toBeVisible();
        await expect(card.locator('.tc-footer').getByRole('button',{name:'Unfollow',exact:true})).toBeVisible();
        const copy = card.locator('.tc-copy');
        const beforeText = await copy.textContent();
        const before = await card.boundingBox();
        await expect.poll(() => card.evaluate(el => {
            const more=el.querySelector('.tc-more'), ellipsis=el.querySelector('.tc-ellipsis');
            const footer=el.querySelector('.tc-footer').getBoundingClientRect(), sheet=el.getBoundingClientRect();
            return {inline:more.closest('p')!==null && Math.abs(more.getBoundingClientRect().top-ellipsis.getBoundingClientRect().top)<5, bottom:footer.bottom<=sheet.bottom && footer.top>=sheet.top, overflow:el.scrollWidth>el.clientWidth};
        })).toEqual({inline:true,bottom:true,overflow:false});
        await card.getByRole('button',{name:'Show more',exact:true}).click();
        await expect.poll(async () => (await copy.textContent()).length).toBeGreaterThan(beforeText.length);
        expect((await card.boundingBox()).height).toBeGreaterThanOrEqual(before.height);
        await expect.poll(() => card.locator('.tc-scroll').evaluate(el => el.scrollHeight>el.clientHeight)).toBe(true);
        await expect(card.locator('.tc-footer').getByRole('button',{name:'Unfollow',exact:true})).toBeInViewport({ratio:1});
        await card.getByRole('button',{name:'Show less',exact:true}).click();
        await expect(copy).toHaveText(beforeText);
    });
}

for (const count of [1,2,3,7]) {
    test(`Released ${count} seasons fill rows with equal dates and compact disclosure`,async({page})=>{
        const {card}=await openCard(page,'my-aired',{seasons:count});
        const seasons=card.locator('.tc-season:visible');
        await expect(seasons).toHaveCount(Math.min(3,count));
        const measure=()=>card.evaluate(el=>{
            const grid=el.querySelector('.tc-season-grid').getBoundingClientRect();
            const rows=[...el.querySelectorAll('.tc-season')].filter(row=>!row.hidden);
            const first=rows[0].getBoundingClientRect(),last=rows[Math.min(2,rows.length-1)].getBoundingClientRect();
            return {full:Math.abs(first.left-grid.left)<1 && Math.abs(last.right-grid.right)<1, equal:rows.every(row=>Math.abs(row.getBoundingClientRect().width-first.width)<1), columns:rows.slice(0,3).every(row=>row.getBoundingClientRect().top===first.top)};
        });
        await expect.poll(measure).toEqual({full:true,equal:true,columns:true});
        if(count<=2) await expect.poll(()=>seasons.first().evaluate(el=>{const [date,year]=el.querySelector('strong').children;return Math.abs(date.getBoundingClientRect().top-year.getBoundingClientRect().top)<3;})).toBe(true);
        if(count>3){
            const description=await card.locator('.tc-description').boundingBox();
            const frame=await card.boundingBox();
            await card.locator('.tc-seasons-more').click();
            await expect(seasons).toHaveCount(count);
            expect((await card.locator('.tc-description').boundingBox()).height).toBeCloseTo(description.height,0);
            expect((await card.boundingBox()).height).toBeGreaterThanOrEqual(frame.height);
            await expect(card.locator('.tc-footer')).toBeInViewport({ratio:1});
            await card.locator('.tc-seasons-more').click();
            await expect(seasons).toHaveCount(3);
        } else await expect(card.locator('.tc-seasons-more')).toHaveCount(0);
    });
}

for(const kind of ['series','films']) test(`Released ${kind} unfollows through the shared account confirmation`,async({page})=>{
    const panel=await mockPanel(page,{role:'user'});
    await openSection(page,'my-aired');
    await page.locator(`#my-aired-${kind} .history-open`).first().click();
    const modal=page.locator('#released-modal');
    await modal.getByRole('button',{name:'Unfollow',exact:true}).click();
    await page.locator('#confirm-modal').getByRole('button',{name:'Keep following'}).click();
    expect(panel.account.sent.filter(r=>r.method==='DELETE')).toHaveLength(0);
    panel.account.unfollowError=true;
    await modal.getByRole('button',{name:'Unfollow',exact:true}).click();
    await page.locator('#confirm-modal').getByRole('button',{name:'Unfollow',exact:true}).click();
    await expect(modal.locator('#released-card-error')).toContainText('Could not unfollow');
    await expect(modal.locator('#released-card-error')).toBeInViewport({ratio:1});
    expect(panel.account.sent.filter(r=>r.method==='DELETE').at(-1).path).toMatch(new RegExp(`/${kind}/${kind==='series'?'tv_100':'9'}$`));
    panel.account.unfollowError=false;
    await modal.getByRole('button',{name:'Unfollow',exact:true}).click();
    await page.locator('#confirm-modal').getByRole('button',{name:'Unfollow',exact:true}).click();
    await expect(modal).toBeHidden();
});

test('phone swipe dismisses from header, description and footer without triggering actions',async({page,browserName})=>{
    test.skip(browserName!=='chromium','CDP supplies real touch gestures; WebKit shares the handler');
    const {card,panel}=await openCard(page,'my-subs');
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    for(const selector of ['.tc-head','.tc-description','.tc-footer']){
        if(!(await page.locator('#mine-card-modal').isVisible())) await page.locator('#my-subs-body .title-row').first().click();
        const rect=await card.locator(selector).boundingBox();
        const x=rect.x+rect.width/2,y=rect.y+8;
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let step=1;step<=6;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+step*20}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await expect(page.locator('#mine-card-modal'),selector).toBeHidden();
    }
    expect(panel.account.sent.filter(r=>r.method==='DELETE')).toHaveLength(0);
    await expect(page.locator('#confirm-modal')).toBeHidden();
});

test('late personal Unfollow cannot close the next admin Released card',async({page})=>{
    const panel=await mockPanel(page);
    await page.locator('.section.active [data-admin-profile] a').click();
    await openSection(page,'my-aired');
    await page.locator('#my-aired-series .history-open').first().click();
    let release;
    panel.account.unfollowHold=new Promise(resolve=>{release=resolve;});
    try {
        await page.locator('#released-modal').getByRole('button',{name:'Unfollow',exact:true}).click();
        await page.locator('#confirm-modal').getByRole('button',{name:'Unfollow',exact:true}).click();
        await expect(page.locator('#released-modal [data-action="mine-ask-unfollow"]')).toBeDisabled();
        await page.locator('#released-modal .sheet-close').click();
        await openProfilePage(page,'my-profile');
        await page.locator('#my-profile-body [data-action="view-admin"]').click();
        await openSection(page,'history');
        await page.locator('#history-series .history-open').first().click();
        await expect(page.locator('#released-title')).toHaveText('Stranger Things');
        const completed=page.waitForResponse(r=>r.request().method()==='DELETE');
        release();
        await completed;
        await expect(page.locator('#toast-container')).toContainText('Unfollowed');
        await expect(page.locator('#released-modal')).toBeVisible();
        await expect(page.locator('#released-title')).toHaveText('Stranger Things');
    } finally { release(); }
});
