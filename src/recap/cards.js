/**
 * The year's recap, "Ваш 2026": six cards of 1080x1350 (4:5, how Telegram shows an album without
 * cropping) made from a chat's statistics (src/chat-stats.js). Each card is a tree of elements for
 * satori (src/recap/render.js turns it into a PNG): plain objects, no JSX. A card with nothing to
 * say about its subject says so instead of showing zeros.
 */
const { plural } = require('../calendar');

const WIDTH = 1080;
const HEIGHT = 1350;
const PAD = 80;
const DISPLAY = 'Unbounded, Unbounded Cyr';
const TEXT = 'Manrope, Manrope Cyr';

const MONTHS = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь'
];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const LETTERS = ['Я', 'Ф', 'М', 'А', 'М', 'И', 'И', 'А', 'С', 'О', 'Н', 'Д'];
const regions = new Intl.DisplayNames(['ru'], { type: 'region' });

// One palette per card: background, text, and the accent of its figures
const THEMES = [
    { bg: '#f5b14c', fg: '#1a1206', accent: '#ff6b5e' },
    { bg: '#1d2b6b', fg: '#f3f1ec', accent: '#f5b14c' },
    { bg: '#e9405b', fg: '#fff6ee', accent: '#ffd9a8' },
    { bg: '#0f3d2e', fg: '#e9fbe9', accent: '#9ff0a8' },
    { bg: '#2b1840', fg: '#f6ecff', accent: '#d8b4ff' },
    { bg: '#f3f1ec', fg: '#161513', accent: '#e9405b' }
];

/** An element: satori's { type, props } with the style first. */
function h(type, style, ...children) {
    const flat = children.flat().filter((c) => c !== null && c !== undefined && c !== false && c !== '');
    return { type, props: { style, children: flat.length === 1 ? flat[0] : flat } };
}
// What the two fonts can draw (their Latin and Cyrillic files). Anything else (an emoji in a group's
// name, a title in Japanese) would come out as an empty box, so it is left out
const UNDRAWABLE = /[^\u0000-ÿıŒœʻʼˆ˚˜̩́̄̈Ѐ-џҐґҰұ -⁯€№™−]/gu;

/** The text with only what the fonts draw, spaces tidied; "" when nothing is left. */
const drawable = (value) => String(value).replace(UNDRAWABLE, '').replace(/\s+/g, ' ').trim();

const box = (style, ...children) => h('div', { display: 'flex', ...style }, ...children);
const text = (style, value) =>
    h('div', { display: 'flex', fontFamily: TEXT, fontWeight: 700, ...style }, drawable(value));
const display = (style, value) =>
    h('div', { display: 'flex', fontFamily: DISPLAY, fontWeight: 900, ...style }, drawable(value));

const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const hours = (minutes) => Math.round((minutes || 0) / 60);
const country = (code) => {
    try {
        return regions.of(code) || code;
    } catch {
        return code;
    }
};
/** Long titles get smaller: a big figure of a title must stay on its card. */
const fit = (value, size, chars) =>
    Math.max(Math.round(size * 0.55), Math.min(size, Math.round((size * chars) / Math.max(1, String(value).length))));
const short = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The frame every card shares: brand top left, "n/6" top right, the content, a footer. */
function frame(n, theme, kicker, content, footer, extra = []) {
    // The margin sits on an inner block of a fixed size: padding on the card would add to its width
    return box(
        {
            width: WIDTH,
            height: HEIGHT,
            background: theme.bg,
            color: theme.fg,
            position: 'relative',
            overflow: 'hidden'
        },
        ...extra,
        box(
            {
                position: 'absolute',
                left: PAD,
                top: PAD,
                width: WIDTH - 2 * PAD,
                height: HEIGHT - 2 * PAD,
                flexDirection: 'column'
            },
            box(
                { justifyContent: 'space-between', alignItems: 'center' },
                display({ fontSize: 30, fontWeight: 700, letterSpacing: 4, opacity: 0.75 }, kicker.toUpperCase()),
                display({ fontSize: 30, fontWeight: 700, opacity: 0.5 }, `${n}/6`)
            ),
            box({ flexDirection: 'column', flexGrow: 1, marginTop: 50 }, ...content),
            footer ? text({ fontSize: 34, opacity: 0.85, lineHeight: 1.3 }, footer) : null
        )
    );
}

const kicker = (value, style = {}) => text({ fontSize: 40, opacity: 0.8, marginTop: 10, ...style }, value);
const sub = (value, style = {}) =>
    text({ fontSize: 44, lineHeight: 1.3, marginTop: 24, opacity: 0.92, ...style }, value);
const divider = (theme) => box({ height: 3, background: theme.fg, opacity: 0.15, marginTop: 50, marginBottom: 40 });
const pill = (theme, value) =>
    text(
        {
            fontSize: 34,
            padding: '14px 28px',
            borderRadius: 999,
            background: theme.pill || 'rgba(255,255,255,0.16)',
            marginRight: 18,
            marginTop: 18
        },
        value
    );

/** A numbered list: rank, name, a quiet figure. */
function ranks(items, mark = (i) => String(i + 1)) {
    return box(
        { flexDirection: 'column', marginTop: 40 },
        items.map((item, i) =>
            box(
                { alignItems: 'center', marginTop: i ? 26 : 0 },
                display({ fontSize: 36, width: 70, opacity: 0.6 }, mark(i)),
                text({ fontSize: 48, flexGrow: 1, flexShrink: 1 }, short(item.name, 26)),
                text({ fontSize: 36, opacity: 0.75, marginLeft: 20 }, item.note)
            )
        )
    );
}

// --- The six cards ---

function cover(stats, { year, chatName }) {
    const theme = THEMES[0];
    const h1 = hours(stats.episodes.minutes + stats.films.minutes);
    const main = h1
        ? [
              display({ fontSize: 112, marginTop: 110, letterSpacing: -2 }, plural(h1, 'час', 'часа', 'часов')),
              sub('премьер вышло у того, на что вы подписаны')
          ]
        : [
              display(
                  { fontSize: 112, marginTop: 110 },
                  plural(stats.following.series + stats.following.films, 'тайтл', 'тайтла', 'тайтлов')
              ),
              sub('вы ждёте вместе с ботом')
          ];
    return frame(
        1,
        theme,
        'NotFckBot',
        [
            text({ fontSize: 56, marginTop: 70 }, 'Ваш'),
            display({ fontSize: 230, lineHeight: 0.95, letterSpacing: -6 }, year),
            text({ fontSize: 60, fontWeight: 800, lineHeight: 1.15, marginTop: 16 }, 'в сериалах'),
            text({ fontSize: 60, fontWeight: 800, lineHeight: 1.15 }, 'и фильмах'),
            ...main
        ],
        `${short(chatName, 28)} · листайте ›`,
        [
            box({
                position: 'absolute',
                width: 640,
                height: 640,
                borderRadius: 320,
                background: theme.accent,
                right: -230,
                top: -200
            })
        ]
    );
}

function episodes(stats, { year }) {
    const theme = THEMES[1];
    const ep = stats.episodes;
    if (!ep.count) {
        return frame(
            2,
            theme,
            'Серии',
            [
                display({ fontSize: 120, marginTop: 60 }, 'Пауза'),
                sub(`В ${year} у ваших сериалов не вышло ни одной серии. Зато следующий год — ваш.`)
            ],
            null
        );
    }
    const counts = Array.from({ length: 12 }, (_, i) => {
        const month = ep.byMonth.find((m) => m.month === `${year}-${String(i + 1).padStart(2, '0')}`);
        return month ? month.count : 0;
    });
    const max = Math.max(...counts, 1);
    const busiest = counts.indexOf(Math.max(...counts));
    return frame(
        2,
        theme,
        'Серии',
        [
            display({ fontSize: 220, lineHeight: 1, letterSpacing: -6 }, ep.count),
            sub(
                `${plural(ep.count, 'новая серия', 'новые серии', 'новых серий').replace(/^\d+ /, '')} у ${plural(ep.series, 'вашего сериала', 'ваших сериалов', 'ваших сериалов')} — это ${plural(ep.seasons, 'сезон', 'сезона', 'сезонов')}`
            ),
            box(
                { alignItems: 'flex-end', height: 380, marginTop: 60 },
                counts.map((n, i) =>
                    box({
                        flexGrow: 1,
                        flexBasis: 0,
                        marginLeft: i ? 16 : 0,
                        height: `${Math.max(2, Math.round((n / max) * 100))}%`,
                        borderRadius: '12px 12px 0 0',
                        background: i === busiest ? theme.accent : 'rgba(255,255,255,0.25)'
                    })
                )
            ),
            box(
                { marginTop: 14 },
                LETTERS.map((l, i) =>
                    text(
                        {
                            flexGrow: 1,
                            flexBasis: 0,
                            justifyContent: 'center',
                            fontSize: 28,
                            opacity: 0.6,
                            marginLeft: i ? 16 : 0
                        },
                        l
                    )
                )
            )
        ],
        `Самый плотный месяц — ${MONTHS[busiest]}: ${plural(counts[busiest], 'серия', 'серии', 'серий')}`
    );
}

function taste(stats) {
    const theme = THEMES[2];
    const { genres, networks, countries } = stats.favourites;
    if (!genres.length) {
        return frame(
            3,
            theme,
            'Ваш вкус',
            [
                display({ fontSize: 100, marginTop: 60 }, 'Загадка'),
                sub('Подпишитесь на пару сериалов — и в следующем году бот расскажет, что вы любите.')
            ],
            null
        );
    }
    const top = capital(genres[0].name);
    const where = countries.slice(0, 2).map((c) => country(c.name));
    return frame(
        3,
        theme,
        'Ваш вкус',
        [
            kicker('Любимый жанр'),
            display({ fontSize: fit(top, 120, 9), marginTop: 10 }, top),
            ranks(
                genres.slice(0, 3).map((g, i) => ({
                    name: capital(g.name),
                    note: i ? String(g.n) : plural(g.n, 'тайтл', 'тайтла', 'тайтлов')
                }))
            ),
            networks.length ? divider(theme) : null,
            networks.length ? kicker('Чаще всего — на', { marginTop: 0 }) : null,
            networks.length
                ? box(
                      { flexWrap: 'wrap' },
                      networks.slice(0, 3).map((n) => pill(theme, `${n.name} · ${n.n}`))
                  )
                : null
        ],
        where.length ? `Страна года: ${where[0]}${where[1] ? `, следом ${where[1]}` : ''}` : null
    );
}

function best(stats, { posters }) {
    const theme = THEMES[3];
    const winner = stats.best[0];
    const most = stats.episodes.top[0];
    if (!winner && !most) {
        return frame(
            4,
            theme,
            'Лучшее года',
            [
                display({ fontSize: 100, marginTop: 60 }, 'Всё впереди'),
                sub('Лучшее года появится, когда выйдет что-нибудь из ваших подписок.')
            ],
            null
        );
    }
    const poster = winner && posters.get(winner.poster_url);
    const others = stats.best.slice(1, 3).map((t) => `${short(t.title, 22)} ${t.rating.toFixed(1)}`);
    return frame(
        4,
        theme,
        'Лучшее года',
        [
            winner ? kicker('Самый высокий рейтинг') : null,
            winner
                ? box(
                      { alignItems: 'center', marginTop: 40 },
                      poster
                          ? {
                                type: 'img',
                                props: {
                                    src: poster,
                                    width: 250,
                                    height: 375,
                                    style: { borderRadius: 24, objectFit: 'cover' }
                                }
                            }
                          : box({ width: 250, height: 375, borderRadius: 24, background: 'rgba(255,255,255,0.12)' }),
                      box(
                          { flexDirection: 'column', marginLeft: 50, flexShrink: 1 },
                          text(
                              { fontSize: fit(winner.title, 60, 16), fontWeight: 800, lineHeight: 1.15 },
                              short(winner.title, 40)
                          ),
                          display({ fontSize: 140, color: theme.accent, marginTop: 10 }, winner.rating.toFixed(1)),
                          text({ fontSize: 30, opacity: 0.7 }, 'TMDB')
                      )
                  )
                : null,
            most ? divider(theme) : null,
            most ? kicker('Больше всего серий', { marginTop: 0 }) : null,
            most ? display({ fontSize: fit(most.title, 80, 12), marginTop: 10 }, short(most.title, 30)) : null,
            most
                ? sub(
                      `${plural(most.count, 'серия', 'серии', 'серий')}, ${plural(hours(most.minutes), 'час', 'часа', 'часов')}`,
                      { marginTop: 14 }
                  )
                : null
        ],
        others.length ? `Ещё в топе: ${others.join(' · ')}` : null
    );
}

function farewells(stats) {
    const theme = THEMES[4];
    const gone = stats.finished.slice(0, 3);
    const wait = stats.films.longestWait;
    const content = [
        kicker('Попрощались в этом году'),
        gone.length
            ? ranks(
                  gone.map((s) => ({ name: s.title, note: s.status === 'Canceled' ? 'отменён' : 'завершён' })),
                  () => '×'
              )
            : sub('Ни одного финала — все ваши сериалы ещё идут.', { marginTop: 20 }),
        divider(theme)
    ];
    if (wait && wait.waited) {
        content.push(
            kicker('Дольше всего ждали', { marginTop: 0 }),
            display({ fontSize: fit(wait.title, 72, 14), marginTop: 10 }, short(wait.title, 30)),
            display({ fontSize: 190, color: theme.accent, marginTop: 20, lineHeight: 1 }, wait.waited),
            sub(`${plural(wait.waited, 'день', 'дня', 'дней').replace(/^\d+ /, '')} от добавления до выхода`, {
                marginTop: 10
            })
        );
    } else {
        const films = stats.films.released.length;
        content.push(
            kicker('Фильмы', { marginTop: 0 }),
            display({ fontSize: 150, marginTop: 10 }, films),
            sub(
                films
                    ? `${plural(films, 'фильм', 'фильма', 'фильмов').replace(/^\d+ /, '')} из вашего списка вышли`
                    : 'Из вашего списка в этом году ничего не вышло'
            )
        );
    }
    return frame(5, theme, 'Прощания и ожидание', content, null);
}

function ahead(stats, { year }) {
    const theme = { ...THEMES[5], pill: 'rgba(0,0,0,0.07)' };
    const next = Number(year) + 1;
    const { series, films } = stats.ahead;
    const soon = stats.ahead.next.filter((t) => t.day.startsWith(String(next)));
    const rare = stats.rare[0];
    const content = [kicker(`На ${next} уже анонсировано`)];
    if (series || films) {
        content.push(
            series
                ? display(
                      { fontSize: 100, lineHeight: 1.1, marginTop: 10 },
                      plural(series, 'сериал', 'сериала', 'сериалов')
                  )
                : null,
            films ? display({ fontSize: 100, lineHeight: 1.1 }, plural(films, 'фильм', 'фильма', 'фильмов')) : null,
            box(
                { flexWrap: 'wrap', marginTop: 10 },
                soon
                    .slice(0, 2)
                    .map((t) => pill(theme, `${short(t.title, 18)} · ${MONTHS_SHORT[Number(t.day.slice(5, 7)) - 1]}`)),
                series + films > 2 ? pill(theme, `+${series + films - Math.min(2, soon.length)}`) : null
            )
        );
    } else {
        content.push(sub('Пока ничего не объявлено — бот напишет, как только появятся даты.', { marginTop: 20 }));
    }
    if (rare) {
        content.push(
            divider(theme),
            kicker('Редкий вкус', { marginTop: 0 }),
            sub(`«${short(rare.title, 40)}» — кроме вас его никто не смотрит с ботом`, { marginTop: 16 })
        );
    }
    return frame(6, theme, 'Что дальше', content, `Спасибо, что были с нами в ${year}`);
}

/**
 * The six cards for a chat's year.
 * @param {object} stats computeStats() for the year
 * @param {{ year: number | string, chatName: string, posters?: Map<string, string> }} options
 *   posters: poster URL → data URI, for the best rated title's card
 */
function recapCards(stats, { year, chatName, posters = new Map() }) {
    // A name of emoji alone has nothing left to draw
    const options = { year: String(year), chatName: drawable(chatName) || 'ваш чат', posters };
    return [cover, episodes, taste, best, farewells, ahead].map((card) => card(stats, options));
}

module.exports = { recapCards, drawable, WIDTH, HEIGHT };
